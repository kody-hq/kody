import { expect, test } from 'vitest'
import {
	mergeConnectOauthConfig,
	type StoredIntegrationConfig,
} from '../client/routes/connect-oauth-config.ts'
import {
	buildConnectOauthAuthorizeUrl,
	readConnectOauthQueryConfig,
} from './pages/connect-oauth-shared.ts'

/**
 * Reproduces hosted connect with only ?provider=… against a user-lane Google
 * OAuth app that has no connection yet (empty stored scopes). Before the fix,
 * authorize URLs omitted the scope parameter and Google returned Error 400.
 */

function installBrowserSession() {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
	const originalSessionStorage = Object.getOwnPropertyDescriptor(
		globalThis,
		'sessionStorage',
	)
	const store = new Map<string, string>()
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: globalThis,
	})
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				store.set(key, value)
			},
			removeItem: (key: string) => {
				store.delete(key)
			},
		},
	})
	return {
		[Symbol.dispose]() {
			for (const [name, descriptor] of [
				['window', originalWindow],
				['sessionStorage', originalSessionStorage],
			] as const) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor)
				else Reflect.deleteProperty(globalThis, name)
			}
		},
	}
}

function googlePersonalQuery(href: string) {
	const parsed = readConnectOauthQueryConfig(
		new URL(href, 'https://kody.codes'),
	)
	if (!parsed.ok) throw new Error(parsed.error)
	return parsed.value
}

const googlePersonalStored: StoredIntegrationConfig = {
	name: 'google-personal',
	tokenUrl: 'https://oauth2.googleapis.com/token',
	apiBaseUrl: 'https://www.googleapis.com',
	flow: 'confidential',
	usePkce: false,
	clientId: 'google-personal-client-id',
	hasClientSecret: true,
	requiredHosts: ['www.googleapis.com'],
	authorization: {
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		scopes: [],
		scopeSeparator: ' ',
		extraAuthorizeParams: {
			access_type: 'offline',
			prompt: 'consent',
		},
	},
}

test('BYO Google connect with empty stored scopes fills openid defaults before authorize', async () => {
	using _browser = installBrowserSession()
	const queryConfig = googlePersonalQuery(
		'/connect/oauth?provider=google-personal',
	)
	const config = mergeConnectOauthConfig({
		queryConfig,
		storedIntegration: googlePersonalStored,
	})
	expect(config).not.toBeNull()
	expect(config?.scopes).toEqual(['openid', 'email', 'profile'])

	const href = await buildConnectOauthAuthorizeUrl({
		config: config!,
		hasConfigError: false,
		redirectUri: 'https://kody.codes/connect/oauth',
	})
	const authorize = new URL(href)
	expect(authorize.origin + authorize.pathname).toBe(
		'https://accounts.google.com/o/oauth2/v2/auth',
	)
	expect(authorize.searchParams.get('scope')).toBe('openid email profile')
	expect(authorize.searchParams.get('client_id')).toBe(
		'google-personal-client-id',
	)
})

test('explicit query scopes still win over empty stored Google scopes', async () => {
	using _browser = installBrowserSession()
	const queryConfig = googlePersonalQuery(
		'/connect/oauth?provider=google-personal&scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.readonly',
	)
	const config = mergeConnectOauthConfig({
		queryConfig,
		storedIntegration: googlePersonalStored,
	})
	expect(config?.scopes).toEqual([
		'https://www.googleapis.com/auth/calendar.readonly',
	])
	const href = await buildConnectOauthAuthorizeUrl({
		config: config!,
		hasConfigError: false,
		redirectUri: 'https://kody.codes/connect/oauth',
	})
	expect(new URL(href).searchParams.get('scope')).toBe(
		'https://www.googleapis.com/auth/calendar.readonly',
	)
})

test('platform Google with cleared scopes refuses authorize instead of omitting scope', async () => {
	using _browser = installBrowserSession()
	const queryConfig = googlePersonalQuery(
		'/connect/oauth?provider=google-platform',
	)
	const config = mergeConnectOauthConfig({
		queryConfig,
		storedIntegration: {
			...googlePersonalStored,
			name: 'google-platform',
			platformAppSlug: 'google-platform',
			platformAllowedScopes: [
				'openid',
				'email',
				'profile',
				'https://www.googleapis.com/auth/calendar',
			],
			authorization: {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				scopes: [],
				scopeSeparator: ' ',
				extraAuthorizeParams: {},
			},
		},
	})
	expect(config?.scopes).toEqual([])
	expect(config?.platformAppSlug).toBe('google-platform')
	await expect(
		buildConnectOauthAuthorizeUrl({
			config: config!,
			hasConfigError: false,
			redirectUri: 'https://kody.codes/connect/oauth',
		}),
	).rejects.toThrow(/requires OAuth scopes/)
})

test('GitHub BYO with empty scopes may still omit the scope parameter', async () => {
	using _browser = installBrowserSession()
	const queryConfig = googlePersonalQuery('/connect/oauth?provider=github')
	const config = mergeConnectOauthConfig({
		queryConfig,
		storedIntegration: {
			name: 'github',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
			clientId: 'github-client',
			hasClientSecret: true,
			requiredHosts: ['api.github.com'],
			authorization: {
				authorizeUrl: 'https://github.com/login/oauth/authorize',
				scopes: [],
				scopeSeparator: ' ',
				extraAuthorizeParams: {},
			},
		},
	})
	expect(config?.scopes).toEqual([])
	const href = await buildConnectOauthAuthorizeUrl({
		config: config!,
		hasConfigError: false,
		redirectUri: 'https://kody.codes/connect/oauth',
	})
	expect(new URL(href).searchParams.has('scope')).toBe(false)
})
