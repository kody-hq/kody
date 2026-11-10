import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ConnectOauthConfig } from '#client/routes/connect-oauth-config.ts'
import { createConnectOauthDeviceStep } from './connect-oauth-device-step.tsx'

const api = vi.hoisted(() => ({
	start: vi.fn(),
	poll: vi.fn(),
	render: vi.fn(),
}))
vi.mock('./connect-oauth-shared.ts', () => ({
	startConnectOauthDevice: api.start,
	pollConnectOauthDevice: api.poll,
	readConnectOauthOrgSlug: () => null,
	persistConnectOauthOrgSlug: vi.fn(),
	persistConnectOauthConfig: vi.fn(),
}))
vi.mock('./connect-oauth-forms.tsx', () => ({ renderDeviceStep: api.render }))

const config: ConnectOauthConfig = {
	provider: 'Example',
	providerKey: 'example',
	authorizeHost: 'example.com',
	tokenHost: 'example.com',
	authorizeUrl: null,
	deviceAuthorizationUrl: 'https://example.com/device',
	tokenUrl: 'https://example.com/token',
	apiBaseUrl: null,
	scopes: [],
	flow: 'device',
	usePkce: false,
	tokenExchangeStyle: 'form',
	scopeSeparator: ' ',
	extraAuthorizeParams: {},
	providerSetupInstructions: null,
	dashboardUrl: null,
	clientId: 'example',
	hasClientSecret: false,
	allowedHosts: ['example.com'],
	platformAppSlug: null,
	pinnedAppSlug: null,
	platformLogoPath: null,
	platformDescription: null,
	platformAllowedScopes: [],
}
const started = {
	ok: true,
	sessionId: 'opaque',
	userCode: '123',
	verificationUri: 'https://example.com/device',
	verificationUriComplete: null,
	expiresIn: 1,
	interval: 1,
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
function fixture(selected: ConnectOauthConfig | null = config) {
	let submitting = false
	const host = {
		getConfig: () => selected,
		getSubmitting: () => submitting,
		setSubmitting: (value: boolean) => {
			submitting = value
		},
		setStatus: vi.fn(),
		setStep: vi.fn(),
		onSuccess: vi.fn(),
		update: vi.fn(),
	}
	const step = createConnectOauthDeviceStep(host)
	function view(): { polling: boolean; errorMessage: string | null } {
		step.render(config)
		return api.render.mock.lastCall![0]
	}
	return { step, host, view }
}
beforeEach(() => {
	vi.useFakeTimers()
	vi.stubGlobal('window', {
		location: { href: 'http://localhost/connect/oauth' },
	})
	api.start.mockResolvedValue(started)
})
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	vi.resetAllMocks()
})

test('empty configuration cannot submit; duplicate starts and disposed responses cannot revive timers', async () => {
	const empty = fixture(null)
	await empty.step.handleDeviceConnect()
	expect(api.start).not.toHaveBeenCalled()
	const { step, host, view } = fixture()
	const response = deferred<typeof started>()
	api.start.mockReturnValue(response.promise)
	const first = step.handleDeviceConnect()
	await step.handleDeviceConnect()
	expect(api.start).toHaveBeenCalledTimes(1)
	step.dispose()
	expect(host.getSubmitting()).toBe(false)
	response.resolve(started)
	await first
	expect(view().polling).toBe(false)
	expect(vi.getTimerCount()).toBe(0)
})

test('a pending poll arriving after the local deadline cannot revive an expired spinner', async () => {
	const { step, host, view } = fixture()
	const response = deferred<unknown>()
	api.poll.mockReturnValue(response.promise)
	await step.handleDeviceConnect()
	await vi.advanceTimersByTimeAsync(2000)
	expect(view().polling).toBe(false)
	expect(host.setStatus).toHaveBeenLastCalledWith(expect.any(String), 'error')
	expect(host.setStep).not.toHaveBeenCalledWith('success')
	response.resolve({ ok: true, status: 'pending', expiresIn: 30, interval: 1 })
	await vi.advanceTimersByTimeAsync(5000)
	expect(view().polling).toBe(false)
	expect(api.poll).toHaveBeenCalledTimes(1)
	expect(host.onSuccess).not.toHaveBeenCalled()
	step.dispose()
})

test('an already committed late approval remains authoritative after the local deadline', async () => {
	const { step, host } = fixture()
	const response = deferred<unknown>()
	api.poll.mockReturnValue(response.promise)
	await step.handleDeviceConnect()
	await vi.advanceTimersByTimeAsync(2000)
	response.resolve({
		ok: true,
		status: 'approved',
		accessTokenSaved: true,
		refreshTokenSaved: false,
		hostApprovalLinks: [],
		nextSteps: null,
	})
	await vi.advanceTimersByTimeAsync(0)
	expect(host.onSuccess).toHaveBeenCalledTimes(1)
	expect(host.setStep).toHaveBeenLastCalledWith('success')
	expect(vi.getTimerCount()).toBe(0)
	step.dispose()
})

test('transient failures retry, but provider denial stops the session and owns its error', async () => {
	const { step, host, view } = fixture()
	api.start.mockResolvedValue({ ...started, expiresIn: 60 })
	api.poll
		.mockRejectedValueOnce(new Error('Offline'))
		.mockResolvedValue({ ok: false, status: 'access_denied', error: 'Denied' })
	await step.handleDeviceConnect()
	await vi.advanceTimersByTimeAsync(7500)
	expect(api.poll).toHaveBeenCalledTimes(2)
	expect(view().polling).toBe(false)
	expect(host.setStatus).toHaveBeenLastCalledWith(expect.any(String), 'error')
	expect(host.setStep).toHaveBeenLastCalledWith('device')
	expect(host.onSuccess).not.toHaveBeenCalled()
	expect(host.getSubmitting()).toBe(false)
	expect(vi.getTimerCount()).toBe(0)
	step.dispose()
})
