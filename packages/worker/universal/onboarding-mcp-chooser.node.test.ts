import { expect, test } from 'vitest'
import {
	attachOnboardingMcpPackageListings,
	featuredOnboardingMcpFingerprint,
	hasConnectedOnboardingCustomMcpServer,
	hasConnectedOnboardingFeaturedMcpServer,
	hasConnectedOnboardingWorkspaceMcp,
	hasPendingOnboardingCustomMcpAuth,
	hasPendingOnboardingFeaturedMcpAuth,
	listOnboardingCustomMcpServers,
	listDisconnectedOnboardingFeaturedMcpServers,
	matchOnboardingFeaturedMcpServer,
	normalizeOnboardingMcpServerUrl,
	onboardingFeaturedMcpServers,
	overlayOnboardingFeaturedMcpServers,
} from './onboarding-mcp-chooser.ts'

type OverlayInput = Parameters<typeof overlayOnboardingFeaturedMcpServers>[0]
type RemoteStatus =
	NonNullable<OverlayInput['statusByServerId']> extends Map<string, infer S>
		? S
		: never

const readyStatus: RemoteStatus = {
	connected: true,
	authorizationPending: false,
	state: 'ready',
	error: null,
}

function remotes(
	servers: Array<[id: string, name: string, url: string]>,
	statuses: Record<string, RemoteStatus> = {},
): OverlayInput {
	return {
		settings: servers.map(([id, name, url]) => ({ id, name, url })),
		statusByServerId: new Map(Object.entries(statuses)),
	}
}

test('featured MCP chooser overlays OAuth state and package listings', () => {
	expect(normalizeOnboardingMcpServerUrl('https://mcp.notion.com/mcp/')).toBe(
		'https://mcp.notion.com/mcp',
	)
	expect(
		matchOnboardingFeaturedMcpServer(
			{ name: 'notes', url: 'https://mcp.notion.com/mcp/' },
			onboardingFeaturedMcpServers[0],
		),
	).toBe(true)
	expect(
		matchOnboardingFeaturedMcpServer(
			{ name: 'linear', url: 'https://mcp.linear.app/sse' },
			onboardingFeaturedMcpServers[1],
		),
	).toBe(true)
	expect(
		matchOnboardingFeaturedMcpServer(
			{ name: 'linear', url: 'https://example.test/other' },
			onboardingFeaturedMcpServers[1],
		),
	).toBe(false)

	const disconnected = listDisconnectedOnboardingFeaturedMcpServers()
	expect(hasConnectedOnboardingFeaturedMcpServer(disconnected)).toBe(false)
	expect(hasPendingOnboardingFeaturedMcpAuth(disconnected)).toBe(false)

	const overlaid = overlayOnboardingFeaturedMcpServers(
		remotes([['srv-linear', 'linear', 'https://mcp.linear.app/mcp']], {
			'srv-linear': {
				connected: false,
				authorizationPending: true,
				state: 'authenticating',
				error: null,
			},
		}),
	)
	expect(overlaid[0]?.connected).toBe(false)
	expect(overlaid[0]?.serverId).toBeNull()
	expect(overlaid[1]).toMatchObject({
		id: 'linear',
		connected: false,
		serverId: 'srv-linear',
		authorizationPending: true,
		state: 'authenticating',
	})
	expect(hasPendingOnboardingFeaturedMcpAuth(overlaid)).toBe(true)

	const connected = overlayOnboardingFeaturedMcpServers(
		remotes([['srv-notion', 'notion', 'https://mcp.notion.com/mcp']], {
			'srv-notion': readyStatus,
		}),
	)
	expect(hasConnectedOnboardingFeaturedMcpServer(connected)).toBe(true)
	expect(hasPendingOnboardingFeaturedMcpAuth(connected)).toBe(false)

	const notionListing = {
		id: onboardingFeaturedMcpServers[0].listingId,
		kodyId: 'notion-mcp',
		name: '@kody/notion-mcp',
		description: 'Notion MCP helpers',
		iconUrl: '/icon.png',
		tags: ['notion', 'mcp'],
	}
	const attached = attachOnboardingMcpPackageListings(connected, [
		notionListing,
	])
	expect(attached[0]?.packageListing?.name).toBe('@kody/notion-mcp')
	expect(attached[1]?.packageListing).toBeNull()

	const withoutListing = listDisconnectedOnboardingFeaturedMcpServers()
	const withListing = attachOnboardingMcpPackageListings(withoutListing, [
		notionListing,
	])
	const withInstall = attachOnboardingMcpPackageListings(withoutListing, [
		{
			...notionListing,
			viewerInstall: {
				status: 'installed',
				targetName: '@me/notion-mcp',
				agentPrompt: 'Use @me/notion-mcp',
				packageId: 'pkg-notion-mcp',
				listingAhead: false,
				listingAheadPrompt: null,
				forkAhead: false,
				listingDiffHref: null,
			},
		},
	])
	expect(featuredOnboardingMcpFingerprint(withoutListing)).not.toBe(
		featuredOnboardingMcpFingerprint(withListing),
	)
	expect(featuredOnboardingMcpFingerprint(withListing)).not.toBe(
		featuredOnboardingMcpFingerprint(withInstall),
	)
})

test('custom MCP servers exclude featured remotes and count as a workspace connect', () => {
	const custom = listOnboardingCustomMcpServers(
		remotes(
			[
				['srv-linear', 'linear', 'https://mcp.linear.app/mcp'],
				['srv-acme', 'acme', 'https://mcp.acme.example/mcp'],
				['srv-other-linear', 'linear', 'https://mcp.other.example/mcp'],
			],
			{ 'srv-acme': readyStatus },
		),
	)
	expect(custom).toEqual([
		{
			id: 'srv-acme',
			name: 'acme',
			url: 'https://mcp.acme.example/mcp',
			connected: true,
			authorizationPending: false,
			state: 'ready',
			error: null,
		},
		{
			id: 'srv-other-linear',
			name: 'linear',
			url: 'https://mcp.other.example/mcp',
			connected: false,
			authorizationPending: false,
			state: null,
			error: null,
		},
	])
	expect(hasConnectedOnboardingCustomMcpServer(custom)).toBe(true)
	expect(hasPendingOnboardingCustomMcpAuth(custom)).toBe(false)
	expect(
		hasPendingOnboardingCustomMcpAuth([
			{
				id: 'srv-pending',
				name: 'acme',
				url: 'https://mcp.acme.example/mcp',
				connected: false,
				authorizationPending: true,
				state: 'authenticating',
				error: null,
			},
		]),
	).toBe(true)
	expect(
		hasConnectedOnboardingWorkspaceMcp({
			featuredMcpServers: listDisconnectedOnboardingFeaturedMcpServers(),
			customMcpServers: custom,
		}),
	).toBe(true)
	expect(
		hasConnectedOnboardingWorkspaceMcp({
			featuredMcpServers: listDisconnectedOnboardingFeaturedMcpServers(),
			customMcpServers: [],
		}),
	).toBe(false)
})
