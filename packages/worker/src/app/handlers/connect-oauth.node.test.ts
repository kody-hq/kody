import { connectOauthInput } from '../../../start/connect-input.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as AccountIntegrationsData from '#app/account-integrations-data.ts'
import type * as AuthenticatedUser from '#app/authenticated-user.ts'
import type * as ConnectOauthChooser from '#app/connect-oauth-chooser.ts'
import type * as PageAuth from '#app/page-auth.ts'
import { isBareConnectOauthVisit } from '#app/handlers/connect-oauth.ts'
import { loadConnectOauth } from '../../../start/server/connect.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser:
		vi.fn<
			(
				...args: Parameters<typeof AuthenticatedUser.readAuthenticatedAppUser>
			) => Promise<unknown>
		>(),
	requirePageSession: vi.fn<typeof PageAuth.requirePageSession>(),
	loadAccountIntegrationByName:
		vi.fn<
			(
				...args: Parameters<
					typeof AccountIntegrationsData.loadAccountIntegrationByName
				>
			) => Promise<unknown>
		>(),
	loadExistingConnectionSummary:
		vi.fn<typeof AccountIntegrationsData.loadExistingConnectionSummary>(),
	hasStoredConnectClientSecret:
		vi.fn<typeof AccountIntegrationsData.hasStoredConnectClientSecret>(),
	loadConnectOauthChooser: vi.fn<
		typeof ConnectOauthChooser.loadConnectOauthChooser
	>(async () => ({ options: [] })),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof AuthenticatedUser.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/page-auth.ts', () => ({
	requirePageSession: (
		...args: Parameters<typeof PageAuth.requirePageSession>
	) => mockModule.requirePageSession(...args),
}))

vi.mock('#app/connect-oauth-chooser.ts', () => ({
	loadConnectOauthChooser: (
		...args: Parameters<typeof ConnectOauthChooser.loadConnectOauthChooser>
	) => mockModule.loadConnectOauthChooser(...args),
}))

vi.mock('#app/account-integrations-data.ts', () => ({
	loadAccountIntegrationByName: (
		...args: Parameters<
			typeof AccountIntegrationsData.loadAccountIntegrationByName
		>
	) => mockModule.loadAccountIntegrationByName(...args),
	loadExistingConnectionSummary: (
		...args: Parameters<
			typeof AccountIntegrationsData.loadExistingConnectionSummary
		>
	) => mockModule.loadExistingConnectionSummary(...args),
	hasStoredConnectClientSecret: (
		...args: Parameters<
			typeof AccountIntegrationsData.hasStoredConnectClientSecret
		>
	) => mockModule.hasStoredConnectClientSecret(...args),
}))

const native = vi.hoisted(() => ({
	env: {} as Env,
	request: new Request('https://example.com/login'),
	setResponseHeader: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	getGlobalStartContext: () => ({ env: native.env }),
	createServerOnlyFn: <T>(fn: T) => fn,
	createServerFn: () => {
		let validate = (data: unknown) => data
		const builder = {
			validator: (
				fn: typeof validate | { parse: (data: unknown) => unknown },
			) => {
				validate = typeof fn === 'function' ? fn : (data) => fn.parse(data)
				return builder
			},
			handler:
				(fn: (input: { data: unknown }) => unknown) =>
				(input: { data: unknown }) =>
					fn({ data: validate(input.data) }),
		}
		return builder
	},
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	get env() {
		return native.env
	},
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => native.request,
	setResponseHeader: native.setResponseHeader,
}))
vi.mock('#app/env.ts', () => ({ getEnv: () => native.env }))

const env = {
	COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
} as Env

let loaded: Awaited<ReturnType<typeof loadConnectOauth>> | undefined
async function visit(search = '') {
	native.env = env
	native.request = new Request(`https://example.com/connect/oauth${search}`)
	loaded = await loadConnectOauth({ data: connectOauthInput(search) })
	return loaded
}

function signIn() {
	mockModule.requirePageSession.mockResolvedValue(null)
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: ownerIdFromStored('user-1') },
	})
}

function renderedConnectOauth() {
	return loaded?.payload
}

test('bare and provider visits require a session; signed-in bare visits render the chooser', async () => {
	const bareVisits = {
		'': true,
		'?state=abc': true,
		'?provider=github': false,
		'?code=auth-code&state=abc': false,
		'?error=access_denied&state=abc': false,
	}
	for (const [search, expected] of Object.entries(bareVisits)) {
		const isBare = isBareConnectOauthVisit(
			new URL(`https://example.com/connect/oauth${search}`),
		)
		expect({ search, isBare }).toEqual({ search, isBare: expected })
	}

	mockModule.requirePageSession.mockResolvedValue(
		Response.redirect(
			'https://example.com/login?redirectTo=%2Fconnect%2Foauth',
			302,
		),
	)
	for (const search of ['', '?provider=github']) {
		await expect(visit(search)).rejects.toMatchObject({
			status: 302,
			options: { href: expect.stringContaining('/login') },
		})
	}

	signIn()
	await visit()
	expect(renderedConnectOauth()).toMatchObject({
		ok: true,
		provider: null,
		integration: null,
		chooser: { options: [] },
	})
})

test('provider visits embed SSR loader data with explicit app and platform selection', async () => {
	signIn()
	const record = { name: 'github', platform: true }
	mockModule.loadAccountIntegrationByName.mockResolvedValue(record)
	mockModule.loadExistingConnectionSummary.mockResolvedValue(null)
	mockModule.hasStoredConnectClientSecret.mockResolvedValue(true)

	await visit('?provider=GitHub')
	expect(mockModule.loadAccountIntegrationByName).toHaveBeenCalledWith(
		env,
		expect.anything(),
		'github',
		{ appSlug: undefined, platformSlug: undefined },
	)
	expect(renderedConnectOauth()).toEqual({
		ok: true,
		provider: 'github',
		integration: record,
		builtInAvailable: false,
		existingConnection: null,
		hasStoredClientSecret: true,
		redirectUri: 'https://example.com/connect/oauth',
	})

	mockModule.loadAccountIntegrationByName.mockResolvedValue({
		name: 'google',
		platform: true,
	})
	mockModule.hasStoredConnectClientSecret.mockResolvedValue(false)
	const lookups = [
		['?provider=google&platform=1', 'google', undefined, '1'],
		['?provider=google-2&platform=google', 'google-2', undefined, 'google'],
		['?provider=work&app=google', 'work', 'google', undefined],
	] as const
	for (const [search, name, appSlug, platformSlug] of lookups) {
		await visit(search)
		expect(mockModule.loadAccountIntegrationByName).toHaveBeenLastCalledWith(
			env,
			expect.anything(),
			name,
			{ appSlug, platformSlug },
		)
	}
})

test.each(['?code=auth-code&state=abc', '?error=access_denied&state=abc'])(
	'callback %s embeds only the redirect URI without an account lookup',
	async (search) => {
		mockModule.requirePageSession.mockResolvedValue(null)

		await visit(search)
		expect(mockModule.readAuthenticatedAppUser).not.toHaveBeenCalled()
		expect(mockModule.loadAccountIntegrationByName).not.toHaveBeenCalled()
		expect(renderedConnectOauth()).toEqual({
			ok: true,
			provider: null,
			integration: null,
			redirectUri: 'https://example.com/connect/oauth',
		})
	},
)
