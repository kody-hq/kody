/**
 * Device-flow (RFC 8628) state and poll orchestration for /connect/oauth.
 * Kept out of connect-oauth.tsx so that route stays under the file-size budget.
 */
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
	/** Opaque device session id — kept in memory only; never shown in the UI. */
	let deviceSessionId: string | null = null
	let deviceUserCode = ''
	let deviceVerificationUri = ''
	let deviceVerificationUriComplete: string | null = null
	let deviceExpiresIn = 0
	let devicePolling = false
	let deviceErrorMessage: string | null = null
	let devicePollTimer: ReturnType<typeof setTimeout> | null = null
	let deviceCountdownTimer: ReturnType<typeof setInterval> | null = null
	let devicePollGeneration = 0
	let devicePollIntervalSeconds = 5

	const clearDeviceTimers = () => {
		if (devicePollTimer) {
			clearTimeout(devicePollTimer)
			devicePollTimer = null
		}
		if (deviceCountdownTimer) {
			clearInterval(deviceCountdownTimer)
			deviceCountdownTimer = null
		}
	}

	const resetDeviceState = () => {
		clearDeviceTimers()
		devicePollGeneration += 1
		deviceSessionId = null
		deviceUserCode = ''
		deviceVerificationUri = ''
		deviceVerificationUriComplete = null
		deviceExpiresIn = 0
		devicePolling = false
		deviceErrorMessage = null
		devicePollIntervalSeconds = 5
	}

	/** Clear timers and abandon in-flight polls when the route unmounts. */
	const dispose = () => {
		resetDeviceState()
	}

	const finishDeviceSuccess = (result: {
		accessTokenSaved: boolean
		refreshTokenSaved: boolean
		hostApprovalLinks: unknown
		nextSteps: unknown
	}) => {
		clearDeviceTimers()
		deviceSessionId = null
		devicePolling = false
		deviceErrorMessage = null
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

	const scheduleDevicePoll = (delaySeconds: number) => {
		if (!deviceSessionId) return
		const generation = devicePollGeneration
		clearTimeout(devicePollTimer ?? undefined)
		devicePollTimer = setTimeout(
			() => {
				if (generation !== devicePollGeneration) return
				void runDevicePoll()
			},
			Math.max(1, delaySeconds) * 1000,
		)
	}

	const scheduleTransientRetry = (message: string) => {
		devicePolling = true
		deviceErrorMessage = null
		host.setStatus(message, 'info')
		scheduleDevicePoll(devicePollBackoffSeconds(devicePollIntervalSeconds))
		host.update()
	}

	const runDevicePoll = async () => {
		if (!host.getConfig() || !deviceSessionId) return
		const generation = devicePollGeneration
		const sessionId = deviceSessionId
		devicePolling = true
		host.update()
		try {
			const orgSlug = readConnectOauthOrgSlug(new URL(window.location.href))
			const polled = await pollConnectOauthDevice({ sessionId, orgSlug })
			if (generation !== devicePollGeneration) return
			if (!polled.ok) {
				if (DEVICE_TERMINAL_POLL_STATUSES.has(polled.status)) {
					clearDeviceTimers()
					devicePolling = false
					deviceSessionId = null
					const message =
						polled.status === 'access_denied'
							? 'Authorization was denied. You can start again when ready.'
							: polled.status === 'expired_token'
								? 'This code expired. Start device authorization again.'
								: polled.error
					deviceErrorMessage = message
					host.setStatus(message, 'error')
					host.setStep('device')
					return
				}
				// provider_error, persist_failed, rate_limited, unknown, etc.
				scheduleTransientRetry(
					polled.status === 'persist_failed'
						? `Saving credentials failed: ${polled.error || 'unknown error'}. Retrying…`
						: 'Temporary problem checking authorization. Retrying…',
				)
				return
			}
			if (polled.status === 'approved') {
				finishDeviceSuccess(polled)
				return
			}
			deviceExpiresIn = polled.expiresIn
			devicePollIntervalSeconds = polled.interval
			devicePolling = true
			host.setStatus(
				polled.status === 'slow_down'
					? 'Provider asked us to slow down. Still waiting for approval…'
					: 'Waiting for you to approve on the provider…',
				'info',
			)
			scheduleDevicePoll(polled.interval)
			host.update()
		} catch (error) {
			if (generation !== devicePollGeneration) return
			// Keep sessionId and reschedule — network blips are not terminal.
			scheduleTransientRetry(
				formatConnectOauthCaughtError(
					error,
					'Temporary problem checking authorization. Retrying…',
				),
			)
		}
	}

	const startDeviceCountdown = () => {
		if (deviceCountdownTimer) clearInterval(deviceCountdownTimer)
		deviceCountdownTimer = setInterval(() => {
			if (deviceExpiresIn <= 0) {
				clearDeviceTimers()
				devicePolling = false
				deviceSessionId = null
				deviceErrorMessage =
					'This code expired. Start device authorization again.'
				host.setStatus(deviceErrorMessage, 'error')
				host.update()
				return
			}
			deviceExpiresIn -= 1
			host.update()
		}, 1000)
	}

	const handleDeviceConnect = async () => {
		const config = host.getConfig()
		if (!config || host.getSubmitting()) return
		host.setSubmitting(true)
		resetDeviceState()
		const generation = devicePollGeneration
		host.update()
		try {
			const orgSlug = readConnectOauthOrgSlug(new URL(window.location.href))
			persistConnectOauthOrgSlug(orgSlug)
			persistConnectOauthConfig(config)
			const started = await startConnectOauthDevice({ config, orgSlug })
			// Aborted/reset while start was in flight — do not revive timers.
			if (generation !== devicePollGeneration) return
			if (!started.ok) {
				host.setStatus(started.error, 'error')
				return
			}
			deviceSessionId = started.sessionId
			deviceUserCode = started.userCode
			deviceVerificationUri = started.verificationUri
			deviceVerificationUriComplete = started.verificationUriComplete
			deviceExpiresIn = started.expiresIn
			devicePollIntervalSeconds = started.interval
			devicePolling = true
			deviceErrorMessage = null
			host.setStatus(
				'Enter the code at the provider, then return here while we wait.',
				'info',
			)
			host.setStep('device')
			startDeviceCountdown()
			scheduleDevicePoll(started.interval)
		} catch (error) {
			if (generation !== devicePollGeneration) return
			host.setStatus(
				formatConnectOauthCaughtError(
					error,
					'Unable to start device authorization.',
				),
				'error',
			)
		} finally {
			// Always clear submitting — an aborted start must not leave the
			// connect button stuck disabled across an href reset.
			host.setSubmitting(false)
			if (generation === devicePollGeneration) {
				host.update()
			}
		}
	}

	const restartToConnect = () => {
		resetDeviceState()
		host.setStatus('Ready to connect.', 'info')
		host.setStep('connect')
	}

	const getView = (): ConnectOauthDeviceStepView => ({
		userCode: deviceUserCode,
		verificationUri: deviceVerificationUri,
		verificationUriComplete: deviceVerificationUriComplete,
		expiresIn: deviceExpiresIn,
		polling: devicePolling,
		errorMessage: deviceErrorMessage,
	})

	const render = (config: ConnectOauthConfig) =>
		renderDeviceStep({
			config,
			...getView(),
			onRestart: () => {
				restartToConnect()
			},
		})

	return {
		resetDeviceState,
		dispose,
		handleDeviceConnect,
		restartToConnect,
		render,
	}
}
