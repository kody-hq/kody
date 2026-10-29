import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'

type ConnectOauthChooserKind = 'connection' | 'platform' | 'org-app'

export type ConnectOauthChooserOption = {
	id: string
	href: string
	label: string
	detail: string
	providerKey: string
	logoPath: string | null
	autoLogoPath: string | null
	catalogLogoPath: string | null
	kind: ConnectOauthChooserKind
}

/**
 * A discoverable (enabled + published) platform app, as the discovery
 * surfaces see it. Only the server decides discoverability; this shape
 * carries no draft or disabled apps.
 */
export type ConnectablePlatformApp = {
	slug: string
	label: string
	provider: string
	logoPath: string | null
	catalogLogoPath: string | null
}

/** A connectable built-in as rendered on onboarding and account integrations. */
export type PlatformIntegrationCatalogItem = ConnectablePlatformApp & {
	/** Operator-authored note (limitations, scope caveats), when present. */
	description: string | null
	connectHref: string
}

export function isConnectOauthCallbackUrl(url: URL): boolean {
	return Boolean(url.searchParams.get('code') || url.searchParams.get('error'))
}

export function buildConnectOauthHref(input: {
	name: string
	appSlug?: string
	platformSlug?: string
	/** Creation / team handoff org; omitted for signup-org visits. */
	orgSlug?: string | null
	/** `personal`: connect your own account through the org's `appSlug`. */
	mode?: 'personal'
}): string {
	const params = new URLSearchParams({ provider: input.name })
	const appSlug = input.appSlug?.trim()
	if (appSlug) {
		params.set('app', appSlug)
	}
	const platformSlug = input.platformSlug?.trim()
	if (platformSlug) {
		params.set('platform', platformSlug)
	}
	const orgSlug = input.orgSlug?.trim()
	if (orgSlug) {
		params.set('org', orgSlug)
	}
	if (input.mode) {
		params.set('mode', input.mode)
	}
	return `/connect/oauth?${params.toString()}`
}

/**
 * One-click built-in connect: the connection takes the app slug as its name
 * and `platform=` tells the lookup to resolve the discoverable platform app
 * instead of a bring-your-own record.
 */
export function buildPlatformConnectOauthHref(
	slug: string,
	orgSlug?: string | null,
): string {
	const params = new URLSearchParams({ provider: slug, platform: slug })
	const org = orgSlug?.trim()
	if (org) params.set('org', org)
	return `/connect/oauth?${params.toString()}`
}

/**
 * Discoverable platform apps the user can still newly connect: drops apps
 * they already hold a platform connection to and apps whose slug is already
 * taken by another connection name (connecting would replace it).
 */
export function selectConnectablePlatformApps<
	TApp extends { slug: string },
>(input: {
	platformApps: ReadonlyArray<TApp>
	connections: ReadonlyArray<{
		name: string
		platform: boolean
		appSlug: string
	}>
}): Array<TApp> {
	const takenNames = new Set(
		input.connections.map((connection) => connection.name),
	)
	const connectedPlatformSlugs = new Set(
		input.connections
			.filter((connection) => connection.platform)
			.map((connection) => connection.appSlug),
	)
	return input.platformApps.filter(
		(app) => !takenNames.has(app.slug) && !connectedPlatformSlugs.has(app.slug),
	)
}

export function buildConnectOauthChooserOptions(input: {
	connections: ReadonlyArray<{
		name: string
		label: string
		providerKey: string
		logoPath: string | null
		autoLogoPath: string | null
		catalogLogoPath: string | null
		platform: boolean
		/** Platform connections only: the app is enabled + published. */
		platformDiscoverable?: boolean
		appSlug: string
		canDrive: boolean
	}>
	platformApps: ReadonlyArray<ConnectablePlatformApp>
	/** The org's OAuth apps a member may connect their own account through. */
	orgApps?: ReadonlyArray<{
		slug: string
		label: string
		providerKey: string
		logoPath: string | null
		autoLogoPath: string | null
		catalogLogoPath: string | null
	}>
	/** When set, every chooser link keeps this org through SSR and writes. */
	orgSlug?: string | null
}): Array<ConnectOauthChooserOption> {
	const orgSlug = input.orgSlug?.trim() || null
	const orgAppOptions = orgSlug
		? (input.orgApps ?? []).map((app) => ({
				id: `org-app:${app.slug}`,
				href: buildConnectOauthHref({
					name: app.slug,
					appSlug: app.slug,
					orgSlug,
					mode: 'personal',
				}),
				label: app.label,
				detail: "Connect your own account through this org's app",
				providerKey: normalizeProviderKey(app.providerKey) || app.slug,
				logoPath: app.logoPath,
				autoLogoPath: app.autoLogoPath,
				catalogLogoPath: app.catalogLogoPath,
				kind: 'org-app' as const,
			}))
		: []
	const connectionOptions = input.connections
		.filter((connection) => connection.canDrive)
		.map((connection) => {
			const providerKey =
				normalizeProviderKey(connection.providerKey) || connection.name
			const builtInReconnect =
				connection.platform && connection.platformDiscoverable === true
			return {
				id: `connection:${connection.name}`,
				// Draft/disabled built-in connections reconnect bring-your-own,
				// so their href carries no `app=` that would look like a
				// built-in slug. Discoverable ones reconnect through the
				// built-in lane by connection name.
				href: buildConnectOauthHref({
					name: connection.name,
					appSlug: connection.platform ? undefined : connection.appSlug,
					orgSlug,
				}),
				label: connection.label,
				detail: builtInReconnect
					? 'Reconnect this built-in account'
					: connection.platform
						? 'Set up your own OAuth app to reconnect'
						: 'Reconnect your OAuth app',
				providerKey,
				logoPath: connection.logoPath,
				autoLogoPath: connection.autoLogoPath,
				catalogLogoPath: connection.catalogLogoPath,
				kind: 'connection' as const,
			}
		})
	const platformOptions = selectConnectablePlatformApps({
		platformApps: input.platformApps,
		connections: input.connections,
	}).map((app) => ({
		id: `platform:${app.slug}`,
		href: buildPlatformConnectOauthHref(app.slug, orgSlug),
		label: app.label,
		detail: "Connect with Kody's built-in app",
		providerKey: normalizeProviderKey(app.provider) || app.slug,
		logoPath: app.logoPath,
		autoLogoPath: null,
		catalogLogoPath: app.catalogLogoPath,
		kind: 'platform' as const,
	}))
	return [...orgAppOptions, ...connectionOptions, ...platformOptions]
}
