import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	buildDiscoveryPrompt,
	buildFirstWinPrompt,
	buildMcpServerUrl,
	buildPersistFirstPackagePrompt,
	loadHomePageOnboardingData,
	loadOnboardingData,
	loadPublicOnboardingData,
} from '#app/onboarding-data.ts'
import {
	type OAuthGrantListHelpers,
	type OAuthGrantListItem,
} from '#worker/oauth-grants.ts'

type OnboardingInput = Parameters<typeof loadOnboardingData>[0]

function loadWith(
	grants: Array<OAuthGrantListItem> | OAuthGrantListHelpers['listUserGrants'],
	overrides: Partial<OnboardingInput> & {
		lookupClient?: OAuthGrantListHelpers['lookupClient']
	} = {},
) {
	const { lookupClient, ...input } = overrides
	return loadOnboardingData({
		env: {
			OAUTH_PROVIDER: {
				listUserGrants: Array.isArray(grants)
					? vi.fn(async () => ({ items: grants }))
					: grants,
				...(lookupClient ? { lookupClient } : {}),
			},
		},
		requestUrl: 'http://localhost:3742/onboarding',
		personId: ownerIdFromStored('user-1'),
		username: 'u-b',
		emailVerified: true,
		...input,
	})
}

const noGift = {
	received: false,
	active: false,
	status: 'none',
	expiresAt: null,
	grantedAt: null,
}

const emptyOnboarding = {
	ok: true,
	hasAccessWin: false,
	hasSecondMcpClient: false,
	hasMcpClient: false,
	connectedAgents: [],
	secondAgentStandardGift: noGift,
	needsOnboarding: true,
	featuredListings: [],
	customMcpServers: [],
	persistedPackageName: null,
	accessWinMemorySubject: null,
	checklist: null,
}

function expectDisconnectedFeaturedServers(data: {
	featuredMcpServers: Array<{
		id: string
		connected: boolean
		serverId: string | null
	}>
}) {
	expect(data.featuredMcpServers.map((server) => server.id)).toContain('notion')
	expect(
		data.featuredMcpServers.filter(
			(server) => server.connected || server.serverId !== null,
		),
	).toEqual([])
}

const grant = (
	clientId: string,
	overrides: Partial<OAuthGrantListItem> = {},
): OAuthGrantListItem => ({
	id: `grant-${clientId}`,
	clientId,
	scope: [],
	...overrides,
})

test('onboarding data builds the MCP URL and derives incomplete setup from verification plus grants', async () => {
	expect(
		buildMcpServerUrl({
			env: { APP_BASE_URL: 'https://configured.example' },
			requestUrl: 'https://preview.example/account',
		}),
	).toBe('https://preview.example/mcp')

	// Discovery and first-win prompts must identify the deployment origin so
	// agents know which Kody instance the user is evaluating.
	const previewInput = {
		env: {},
		requestUrl: 'https://preview.example/onboarding',
	}
	expect(buildDiscoveryPrompt(previewInput)).toContain(
		'https://preview.example',
	)
	expect(buildFirstWinPrompt(previewInput)).toContain(
		'https://preview.example/docs/first-win',
	)
	expect(buildPersistFirstPackagePrompt(previewInput)).toContain(
		'https://preview.example/docs/quick-example',
	)

	const heykodyEnv = { APP_BASE_URL: 'https://heykody.dev' }
	const publicData = loadPublicOnboardingData({
		env: heykodyEnv,
		requestUrl: 'https://heykody.dev/onboarding',
	})
	expect(publicData).toMatchObject({
		...emptyOnboarding,
		loggedIn: false,
		username: null,
		mcpServerUrl: 'https://heykody.dev/mcp',
		emailVerified: false,
	})
	expect(publicData.setupPrompt).toMatch(/\S/)
	expect(publicData.discoveryPrompt).toContain('https://heykody.dev')
	expect(publicData.persistPrompt).toContain('https://heykody.dev')
	expectDisconnectedFeaturedServers(publicData)

	const homeAnonymous = loadHomePageOnboardingData({
		env: heykodyEnv,
		requestUrl: 'https://heykody.dev/',
	})
	expect(homeAnonymous).toMatchObject({
		loggedIn: false,
		featuredMcpServers: [],
		setupPrompt: '',
		persistPrompt: '',
	})
	expect(homeAnonymous.discoveryPrompt).toContain('https://heykody.dev')

	expect(
		loadHomePageOnboardingData({
			env: heykodyEnv,
			requestUrl: 'https://heykody.dev/',
			user: { username: 'kent', emailVerified: true },
		}),
	).toMatchObject({
		loggedIn: true,
		username: 'kent',
		emailVerified: true,
		needsOnboarding: false,
		featuredMcpServers: [],
		setupPrompt: '',
		persistPrompt: '',
	})

	const withoutClient = await loadWith([], {
		requestUrl: 'https://heykody.dev/onboarding',
	})
	expect(withoutClient).toMatchObject({
		...emptyOnboarding,
		loggedIn: true,
		username: 'u-b',
		mcpServerUrl: 'https://heykody.dev/mcp',
		emailVerified: true,
	})
	expect(withoutClient.setupPrompt).toMatch(/\S/)
	expect(withoutClient.discoveryPrompt).toContain('https://heykody.dev')
	expectDisconnectedFeaturedServers(withoutClient)

	expect(
		await loadWith([grant('client-a', { id: 'grant-1' })], {
			persistedPackageName: '@u-b/morning-digest',
			accessWinMemorySubject: 'Preferred commute',
		}),
	).toMatchObject({
		username: 'u-b',
		hasMcpClient: true,
		hasSecondMcpClient: false,
		connectedAgents: [
			{
				clientId: 'client-a',
				label: 'client-a',
				kind: null,
				connectedAt: null,
				lastUsedAt: null,
			},
		],
		emailVerified: true,
		needsOnboarding: false,
		mcpServerUrl: 'http://localhost:3742/mcp',
		// Handler-loaded persist target is passed through for Step 3 chrome.
		persistedPackageName: '@u-b/morning-digest',
		accessWinMemorySubject: 'Preferred commute',
	})

	expect(
		await loadWith([
			grant('client-a', { id: 'grant-1' }),
			grant('client-a', { id: 'grant-2' }),
		]),
	).toMatchObject({
		hasMcpClient: true,
		hasSecondMcpClient: false,
		needsOnboarding: false,
		connectedAgents: [{ clientId: 'client-a', kind: null }],
	})

	expect(await loadWith([grant('client-a'), grant('client-b')])).toMatchObject({
		hasMcpClient: true,
		hasSecondMcpClient: false,
		needsOnboarding: false,
		connectedAgents: [
			{ clientId: 'client-a', kind: null },
			{ clientId: 'client-b', kind: null },
		],
		secondAgentStandardGift: noGift,
	})

	expect(
		await loadWith(
			vi.fn<OAuthGrantListHelpers['listUserGrants']>(
				async (_userId, options) =>
					options?.cursor === 'page-2'
						? { items: [grant('client-b')] }
						: { items: [grant('client-a')], cursor: 'page-2' },
			),
		),
	).toMatchObject({ hasMcpClient: true, hasSecondMcpClient: false })

	const dualCursor = await loadWith(
		[
			grant('cursor-local-client', {
				id: 'grant-local',
				redirectUri: 'cursor://anysphere.cursor-mcp/oauth/callback',
			}),
			grant('cursor-cloud-client', {
				id: 'grant-cloud',
				redirectUri: 'https://www.cursor.com/agents/mcp/oauth/callback',
			}),
		],
		{
			lookupClient: vi.fn(async (clientId: string) => ({
				clientId,
				clientName: 'Cursor',
			})),
		},
	)
	expect(dualCursor.connectedAgents.map((agent) => agent.kind)).toEqual([
		'cursor-cloud',
		'cursor-local',
	])
	expect(dualCursor.hasSecondMcpClient).toBe(false)

	const cursorAndClaude = await loadWith(
		[
			grant('cursor-client', {
				id: 'grant-cursor',
				redirectUri: 'http://localhost:8787/callback',
			}),
			grant('claude-client'),
		],
		{
			lookupClient: vi.fn(async (clientId: string) => ({
				clientId,
				clientName: clientId === 'claude-client' ? 'Claude Code' : 'Cursor',
			})),
		},
	)
	expect(cursorAndClaude.hasSecondMcpClient).toBe(true)

	const unverifiedWithGrant = await loadWith([grant('client-a')], {
		requestUrl: 'https://heykody.dev/onboarding',
		emailVerified: false,
		persistedPackageName: '@u-b/morning-digest',
		accessWinMemorySubject: 'Preferred commute',
	})
	expect(unverifiedWithGrant).toMatchObject({
		hasMcpClient: true,
		emailVerified: false,
		needsOnboarding: true,
		mcpServerUrl: '',
		setupPrompt: '',
		persistPrompt: '',
		// Persist next-steps stay empty until verification.
		persistedPackageName: null,
		accessWinMemorySubject: null,
	})
	expect(unverifiedWithGrant.discoveryPrompt).toContain('https://heykody.dev')

	expect(
		await loadWith(
			vi.fn(async () => {
				throw new Error('provider unavailable')
			}),
			{ requestUrl: 'https://heykody.dev/onboarding' },
		),
	).toMatchObject({ hasMcpClient: false, needsOnboarding: true })

	const withCustomPersist = await loadWith([], {
		requestUrl: 'https://heykody.dev/onboarding',
		persistContext: { connectedWorkspaceLabel: 'acme' },
	})
	expect(withCustomPersist.persistPrompt).toContain('acme')
	expect(withCustomPersist.customMcpServers).toEqual([])

	const withExamplePersist = await loadWith([], {
		requestUrl: 'https://heykody.dev/onboarding',
		persistContext: { installedExampleName: '@kody/hn-pulse' },
	})
	expect(withExamplePersist.persistPrompt).toContain('@kody/hn-pulse')
})
