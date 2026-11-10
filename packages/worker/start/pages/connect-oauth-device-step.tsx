import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import {
	connectOauthDeviceState,
	type ConnectOauthDeviceState,
	type DeviceDisplay,
	type DeviceSession,
} from '#client/routes/connect-oauth-device-state.ts'
import { renderDeviceStep } from './connect-oauth-forms.tsx'
import {
	type ConnectOauthConfig,
	type ConnectOauthHostApprovalLink,
	type ConnectOauthNextSteps,
	formatConnectOauthCaughtError,
	parseConnectOauthNextSteps,
	parseHostApprovalLinks,
} from '#client/routes/connect-oauth-config.ts'
import {
	type ConnectOauthStatusTone,
	type ConnectOauthStep,
	persistConnectOauthConfig,
	persistConnectOauthOrgSlug,
	pollConnectOauthDevice,
	readConnectOauthOrgSlug,
	startConnectOauthDevice,
} from './connect-oauth-shared.ts'
/**
 * Device-flow (RFC 8628) state and poll orchestration for /connect/oauth.
 * Kept out of connect-oauth.tsx so that route stays under the file-size budget.
 */

type ConnectOauthDeviceSuccess = {
	accessTokenSaved: boolean
	refreshTokenSaved: boolean
	hostApprovalLinks: Array<ConnectOauthHostApprovalLink>
	nextSteps: ConnectOauthNextSteps | null
}

type ConnectOauthDeviceHost = {
	getConfig: () => ConnectOauthConfig | null
	getSubmitting: () => boolean
	setSubmitting: (value: boolean) => void
	setStatus: (message: string, tone?: ConnectOauthStatusTone) => void
	setStep: (step: ConnectOauthStep) => void
	onSuccess: (result: ConnectOauthDeviceSuccess) => void
	update: () => void
}

type ConnectOauthDeviceStepView = {
	userCode: string
	verificationUri: string
	verificationUriComplete: string | null
	expiresIn: number
	polling: boolean
	errorMessage: string | null
}

const DEVICE_TERMINAL_POLL_STATUSES = new Set([
	'access_denied',
	'expired_token',
	'invalid_session',
])

function devicePollBackoffSeconds(intervalSeconds: number) {
	const base = Math.max(intervalSeconds, 5)
	const jitter = Math.floor(Math.random() * 1000) / 1000
	return base + jitter
}

export function createConnectOauthDeviceStep(host: ConnectOauthDeviceHost) {
	const flow = createActor(connectOauthDeviceState).start()
	let devicePollTimer: ReturnType<typeof setTimeout> | null = null
	let deviceCountdownTimer: ReturnType<typeof setInterval> | null = null
	let generation = 0
	const display = (session: DeviceSession): DeviceDisplay => ({
		userCode: session.userCode,
		verificationUri: session.verificationUri,
		verificationUriComplete: session.verificationUriComplete,
		expiresIn: session.expiresIn,
	})
	function view() {
		const state = uiState<ConnectOauthDeviceState>(flow.getSnapshot())
		return state.status === 'polling'
			? display(state.session)
			: state.status === 'error' || state.status === 'success'
				? state.view
				: null
	}
	function clearDeviceTimers() {
		if (devicePollTimer) clearTimeout(devicePollTimer)
		if (deviceCountdownTimer) clearInterval(deviceCountdownTimer)
		devicePollTimer = null
		deviceCountdownTimer = null
	}
	function resetDeviceState() {
		clearDeviceTimers()
		generation++
		if (
			uiState<ConnectOauthDeviceState>(flow.getSnapshot()).status === 'starting'
		)
			host.setSubmitting(false)
		sendUiEvent(flow, {
			...({
				type: 'RESET',
				data: uiContext({ status: 'idle' }).data,
			} as Parameters<typeof flow.send>[0]),
			requestId: generation,
		})
	}
	function fail(
		message: string,
		device: DeviceDisplay | null,
		requestId = generation,
	) {
		clearDeviceTimers()
		sendUiEvent(flow, {
			...({
				type: 'RESPONSE_ERROR',
				data: uiContext({ status: 'error', message, view: device }).data,
			} as Parameters<typeof flow.send>[0]),
			requestId: requestId,
		})
		host.setStatus(message, 'error')
	}
	function finishDeviceSuccess(
		result: {
			accessTokenSaved: boolean
			refreshTokenSaved: boolean
			hostApprovalLinks: unknown
			nextSteps: unknown
		},
		requestId: number,
	) {
		const device = view()
		if (
			!device ||
			!sendUiEvent(flow, {
				...({
					type: 'RESPONSE_OK',
					data: uiContext({ status: 'success', view: device }).data,
				} as Parameters<typeof flow.send>[0]),
				requestId: requestId,
			})
		)
			return
		clearDeviceTimers()
		persistConnectOauthOrgSlug(null)
		host.onSuccess({
			accessTokenSaved: result.accessTokenSaved,
			refreshTokenSaved: result.refreshTokenSaved,
			hostApprovalLinks: parseHostApprovalLinks(result.hostApprovalLinks),
			nextSteps: parseConnectOauthNextSteps(result.nextSteps),
		})
		host.setStatus('OAuth credentials saved.', 'info')
		host.setStep('success')
	}
	function scheduleDevicePoll(delaySeconds: number) {
		if (
			uiState<ConnectOauthDeviceState>(flow.getSnapshot()).status !== 'polling'
		)
			return
		const ownGeneration = generation
		clearTimeout(devicePollTimer ?? undefined)
		devicePollTimer = setTimeout(
			() => {
				if (ownGeneration === generation) void runDevicePoll()
			},
			Math.max(1, delaySeconds) * 1000,
		)
	}
	function scheduleTransientRetry(message: string) {
		const state = uiState<ConnectOauthDeviceState>(flow.getSnapshot())
		if (state.status !== 'polling') return
		host.setStatus(message, 'info')
		scheduleDevicePoll(devicePollBackoffSeconds(state.session.interval))
		host.update()
	}
	async function runDevicePoll() {
		const current = uiState<ConnectOauthDeviceState>(flow.getSnapshot())
		if (!host.getConfig() || current.status !== 'polling') return
		const ownGeneration = generation
		host.update()
		try {
			const orgSlug = readConnectOauthOrgSlug(new URL(window.location.href))
			const polled = await pollConnectOauthDevice({
				sessionId: current.session.sessionId,
				orgSlug,
			})
			if (ownGeneration !== generation) return
			if (polled.ok && polled.status === 'approved') {
				finishDeviceSuccess(polled, ownGeneration)
				return
			}
			const active = uiState<ConnectOauthDeviceState>(flow.getSnapshot())
			if (active.status !== 'polling') return
			if (!polled.ok) {
				if (DEVICE_TERMINAL_POLL_STATUSES.has(polled.status)) {
					const message =
						polled.status === 'access_denied'
							? 'Authorization was denied. You can start again when ready.'
							: polled.status === 'expired_token'
								? 'This code expired. Start device authorization again.'
								: polled.error
					fail(message, display(active.session))
					host.setStep('device')
					return
				}
				scheduleTransientRetry(
					polled.status === 'persist_failed'
						? `Saving credentials failed: ${polled.error || 'unknown error'}. Retrying…`
						: 'Temporary problem checking authorization. Retrying…',
				)
				return
			}
			sendUiEvent(flow, {
				...({
					type: flow.getSnapshot().matches('polling')
						? 'POLL_PENDING'
						: 'SESSION_OK',
					data: uiContext({
						status: 'polling',
						session: {
							...active.session,
							expiresIn: polled.expiresIn,
							interval: polled.interval,
						},
					}).data,
				} as Parameters<typeof flow.send>[0]),
				requestId: ownGeneration,
			})
			host.setStatus(
				polled.status === 'slow_down'
					? 'Provider asked us to slow down. Still waiting for approval…'
					: 'Waiting for you to approve on the provider…',
				'info',
			)
			scheduleDevicePoll(polled.interval)
			host.update()
		} catch (error) {
			if (ownGeneration !== generation) return
			scheduleTransientRetry(
				formatConnectOauthCaughtError(
					error,
					'Temporary problem checking authorization. Retrying…',
				),
			)
		}
	}
	function startDeviceCountdown() {
		if (deviceCountdownTimer) clearInterval(deviceCountdownTimer)
		deviceCountdownTimer = setInterval(() => {
			const current = uiState<ConnectOauthDeviceState>(flow.getSnapshot())
			if (current.status !== 'polling') {
				clearDeviceTimers()
				return
			}
			if (current.session.expiresIn <= 0) {
				fail(
					'This code expired. Start device authorization again.',
					display(current.session),
				)
				host.update()
				return
			}
			sendUiEvent(flow, {
				...({
					type: 'TICK',
					data: uiContext({
						status: 'polling',
						session: {
							...current.session,
							expiresIn: current.session.expiresIn - 1,
						},
					}).data,
				} as Parameters<typeof flow.send>[0]),
				requestId: generation,
			})
			host.update()
		}, 1000)
	}
	async function handleDeviceConnect() {
		const config = host.getConfig()
		if (!config || host.getSubmitting()) return
		resetDeviceState()
		if (
			!sendUiEvent(flow, {
				...({
					type: 'START',
					data: uiContext({ status: 'starting' }).data,
				} as Parameters<typeof flow.send>[0]),
				requestId: generation,
			})
		)
			return
		host.setSubmitting(true)
		const ownGeneration = generation
		host.update()
		try {
			const orgSlug = readConnectOauthOrgSlug(new URL(window.location.href))
			persistConnectOauthOrgSlug(orgSlug)
			persistConnectOauthConfig(config)
			const started = await startConnectOauthDevice({ config, orgSlug })
			if (ownGeneration !== generation) return
			if (!started.ok) {
				fail(started.error, null)
				return
			}
			sendUiEvent(flow, {
				...({
					type: flow.getSnapshot().matches('polling')
						? 'POLL_PENDING'
						: 'SESSION_OK',
					data: uiContext({ status: 'polling', session: started }).data,
				} as Parameters<typeof flow.send>[0]),
				requestId: generation,
			})
			host.setStatus(
				'Enter the code at the provider, then return here while we wait.',
				'info',
			)
			host.setStep('device')
			startDeviceCountdown()
			scheduleDevicePoll(started.interval)
		} catch (error) {
			if (ownGeneration !== generation) return
			fail(
				formatConnectOauthCaughtError(
					error,
					'Unable to start device authorization.',
				),
				null,
			)
		} finally {
			if (ownGeneration === generation) {
				host.setSubmitting(false)
				host.update()
			}
		}
	}
	function restartToConnect() {
		resetDeviceState()
		host.setStatus('Ready to connect.', 'info')
		host.setStep('connect')
	}
	function getView(): ConnectOauthDeviceStepView {
		const state = uiState<ConnectOauthDeviceState>(flow.getSnapshot()),
			device = view()
		return {
			userCode: device?.userCode ?? '',
			verificationUri: device?.verificationUri ?? '',
			verificationUriComplete: device?.verificationUriComplete ?? null,
			expiresIn: device?.expiresIn ?? 0,
			polling: state.status === 'polling',
			errorMessage:
				state.status === 'error' && state.view ? state.message : null,
		}
	}
	const render = (config: ConnectOauthConfig) =>
		renderDeviceStep({ config, ...getView(), onRestart: restartToConnect })
	return {
		actor: flow,
		resetDeviceState,
		dispose: resetDeviceState,
		handleDeviceConnect,
		restartToConnect,
		render,
	}
}
