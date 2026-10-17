import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterContextProvider,
	redirect,
} from '@tanstack/react-router'
const state = vi.hoisted(() => ({
	social: vi.fn(),
	integration: vi.fn(),
	chooser: vi.fn(),
	saveApp: vi.fn(),
	exchange: vi.fn(),
	connect: vi.fn(),
	session: vi.fn(),
	resend: vi.fn(),
	assign: vi.fn(),
}))
vi.mock('#start/server/auth-mutations', () => ({
	startWebsiteOAuth: state.social,
	readWebsiteAuthProviders: vi.fn(),
	resendWebsiteVerification: state.resend,
}))
vi.mock('#start/server/session-info', () => ({
	readWebsiteSessionInfo: state.session,
}))
vi.mock('#start/server/account-mutations', () => ({
	connectOAuth: state.connect,
	exchangeOAuthToken: state.exchange,
	saveOAuthApp: state.saveApp,
}))
vi.mock('#start/server/connect-integration', () => ({
	readConnectIntegration: state.integration,
	readConnectChooser: state.chooser,
}))
import {
	useConnectOauthOperations,
	readConnectOauthQueryConfig,
} from './pages/connect-oauth-shared.ts'
import { mergeConnectOauthConfig } from '../client/routes/connect-oauth-config.ts'
import { useSocialSignIn } from './social-sign-in.ts'
import { useSessionInfo } from './session-info.ts'
import { useResendVerification } from './pages/email-verification-prompt.tsx'

async function renderAuthHooks(throwOnSessionError = false) {
	const root = createRootRoute()
	const router = createRouter({
		origin: 'https://kody.test',
		isServer: false,
		history: createMemoryHistory({ initialEntries: ['/account/passkeys'] }),
		routeTree: root.addChildren([
			createRoute({ getParentRoute: () => root, path: '/account/passkeys' }),
		]),
	})
	await router.load()
	// Only full document navigation is a mocked browser boundary. React hooks,
	// router context, redirect resolution and Start's useServerFn remain real.
	const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(undefined)
	type AuthOperations = {
		social: ReturnType<typeof useSocialSignIn>
		session: ReturnType<typeof useSessionInfo>
		resend: ReturnType<typeof useResendVerification>
		connection: ReturnType<typeof useConnectOauthOperations>
	}
	const rendered: AuthOperations[] = []
	function AuthHooks() {
		const hooks = {
			social: useSocialSignIn(),
			session: useSessionInfo({ throwOnError: throwOnSessionError }),
			resend: useResendVerification(),
			connection: useConnectOauthOperations(),
		}
		rendered.push(hooks)
		return null
	}
	renderToString(
		createElement(RouterContextProvider, {
			router,
			children: createElement(AuthHooks),
		}),
	)
	if (!rendered[0]) throw new Error('Auth hooks did not render')
	return { ...rendered[0], navigate }
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubGlobal('window', { location: { assign: state.assign } })
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

test('imperative auth hooks honor native identity reloads without continuing success work', async () => {
	const hooks = await renderAuthHooks()
	const identityChanged = () =>
		redirect({ href: '/account/passkeys', reloadDocument: true, replace: true })
	state.social.mockRejectedValue(identityChanged())
	state.session.mockRejectedValue(identityChanged())
	state.resend.mockRejectedValue(identityChanged())
	expect(await hooks.social('github', null)).toBeNull()
	expect(await hooks.session()).toBeUndefined()
	expect(await hooks.resend()).toBeUndefined()
	expect(hooks.navigate).toHaveBeenCalledTimes(3)
	expect(hooks.navigate).toHaveBeenCalledWith(
		expect.objectContaining({
			href: '/account/passkeys',
			reloadDocument: true,
			replace: true,
		}),
	)
	expect(state.assign).not.toHaveBeenCalled()
})

test('successful social authorization and resend retain their real result', async () => {
	const hooks = await renderAuthHooks()
	state.social.mockResolvedValue({
		successful: true,
		ok: true,
		authorizeUrl: 'https://github.com/login/oauth/authorize',
	})
	state.resend.mockResolvedValue({
		successful: true,
		ok: true,
		message: 'Sent.',
	})
	expect(await hooks.social('github', '/account')).toBeNull()
	expect(state.assign).toHaveBeenCalledWith(
		'https://github.com/login/oauth/authorize',
	)
	expect(await hooks.resend('/account')).toEqual({
		ok: true,
		message: 'Sent.',
	})
	expect(hooks.navigate).not.toHaveBeenCalled()
})

function oauthConfig() {
	const parsed = readConnectOauthQueryConfig(
		new URL(
			'https://kody.codes/connect/oauth?provider=example&authorizeUrl=https://example.com/authorize&tokenUrl=https://example.com/token&flow=confidential',
		),
	)
	if (!parsed.ok) throw new Error(parsed.error)
	const config = mergeConnectOauthConfig({
		queryConfig: parsed.value,
		storedIntegration: null,
	})
	if (!config) throw new Error('OAuth fixture requires a complete config')
	return {
		...config,
		clientId: 'client-id',
		usePkce: false,
	}
}

test('all imperative connection operations yield to native identity redirects', async () => {
	for (const operation of [
		state.integration,
		state.chooser,
		state.saveApp,
		state.exchange,
		state.connect,
	]) {
		operation.mockRejectedValue(
			redirect({ href: '/connect/oauth', reloadDocument: true, replace: true }),
		)
	}
	const hooks = await renderAuthHooks()
	const operations = hooks.connection
	const config = oauthConfig()
	expect(
		await operations.readIntegration({ data: { name: 'example' } }),
	).toBeUndefined()
	expect(await operations.readChooser({ data: {} })).toBeUndefined()
	expect(await operations.saveApp(config, 'secret')).toBeUndefined()
	expect(
		await operations.exchangeCode(
			config,
			'code',
			'https://kody.codes/connect/oauth',
		),
	).toBeUndefined()
	expect(
		await operations.saveConnection({
			config,
			callbackUrl: 'https://kody.codes/connect/oauth',
			tokenPayload: { access_token: 'token' },
			orgSlug: null,
		}),
	).toBeUndefined()
	expect(hooks.navigate).toHaveBeenCalledTimes(5)
	expect(hooks.navigate).toHaveBeenCalledWith(
		expect.objectContaining({
			href: '/connect/oauth',
			reloadDocument: true,
			replace: true,
		}),
	)
})

test('connection operations retain token results and propagate ordinary failures', async () => {
	state.exchange.mockResolvedValue({ access_token: 'token' })
	state.connect.mockResolvedValue({
		accessTokenSaved: true,
		refreshTokenSaved: false,
		nextSteps: null,
	})
	const hooks = await renderAuthHooks()
	const operations = hooks.connection
	const config = oauthConfig()
	const result = await operations.exchangeCode(
		config,
		'code',
		'https://kody.codes/connect/oauth',
	)
	expect(result).toEqual({
		ok: true,
		status: 200,
		data: { access_token: 'token' },
	})
	expect(
		await operations.saveConnection({
			config,
			callbackUrl: 'https://kody.codes/connect/oauth',
			tokenPayload: { access_token: 'token' },
			orgSlug: null,
		}),
	).toEqual({
		ok: true,
		accessTokenSaved: true,
		refreshTokenSaved: false,
		nextSteps: null,
	})
	state.exchange.mockRejectedValue(new Error('Provider unavailable'))
	await expect(
		operations.exchangeCode(config, 'code', 'https://kody.codes/connect/oauth'),
	).rejects.toThrow('Provider unavailable')
	expect(hooks.navigate).not.toHaveBeenCalled()
})

test('verification polling preserves transport failures while retaining native signed-out results', async () => {
	const { session } = await renderAuthHooks(true)
	const failure = new Error('session network failed')
	state.session.mockRejectedValueOnce(failure)
	await expect(session()).rejects.toBe(failure)
	state.session.mockResolvedValueOnce(null)
	expect(await session()).toBeNull()
})
