import { createListDetailLinks } from '#client/list-detail-route.ts'
import { matchesSearchQuery } from '#client/search-filter.ts'
import {
	type AccountIntegrationListItem,
	type AccountOauthAppListItem,
} from '#universal/loader-data.ts'
import { relocateAccountHref } from '#universal/org-pages.ts'
import { getDangerPillCss } from '#universal/styles/style-primitives.ts'

export const integrationsRoute = createListDetailLinks('/account/integrations')

function buildOauthAppHref(appSlug: string, search = '', currentHref = '') {
	const path = `/account/integrations/apps/${encodeURIComponent(appSlug)}`
	const href = search
		? `${path}?${new URLSearchParams(search).toString()}`
		: path
	return currentHref ? relocateAccountHref(href, currentHref) : href
}

export function oauthAppTitle(app: AccountOauthAppListItem) {
	return app.label?.trim() || app.provider || app.slug
}

export function isBuiltInApp(app: AccountOauthAppListItem) {
	return app.platform === true
}

export function integrationListId(app: AccountOauthAppListItem) {
	return isBuiltInApp(app) ? `platform:${app.slug}` : `user:${app.slug}`
}

function findAppForConnection(
	apps: ReadonlyArray<AccountOauthAppListItem>,
	connection: AccountIntegrationListItem,
) {
	return (
		apps.find(
			(app) =>
				app.slug === connection.appSlug &&
				isBuiltInApp(app) === Boolean(connection.platform),
		) ?? null
	)
}

export function buildIntegrationHref(
	app: AccountOauthAppListItem,
	search = '',
	currentHref = '',
) {
	if (isBuiltInApp(app)) {
		const first = app.connections[0]
		return first
			? integrationsRoute.buildDetailHref(first.name, search, currentHref)
			: relocateAccountHref('/account/integrations', currentHref)
	}
	return buildOauthAppHref(app.slug, search, currentHref)
}

export function accountsConnectedCopy(count: number) {
	if (count === 0) return 'No accounts connected yet.'
	if (count === 1) return '1 account connected.'
	return `${count} accounts connected.`
}

export function connectionLabel(connection: {
	name: string
	accountLabel?: string | null
}) {
	return connection.accountLabel?.trim() || connection.name
}

export function deletedAppCopy(title: string, connectionCount: number) {
	if (connectionCount === 0) return `Deleted ${title}.`
	if (connectionCount === 1) return `Deleted ${title} and 1 account.`
	return `Deleted ${title} and ${connectionCount} accounts.`
}

export type IntegrationUsageDraft = {
	usageMode: 'any' | 'packages'
	allowedPackageIds: Array<string>
}

export type IntegrationsSelection =
	| { kind: 'list' | 'approval' }
	| { kind: 'app'; appSlug: string }
	| { kind: 'connection'; connectionName: string }

export function resolveIntegrationsSelection(input: {
	selection: IntegrationsSelection
	apps: ReadonlyArray<AccountOauthAppListItem>
	integrations: ReadonlyArray<AccountIntegrationListItem>
}) {
	const selectedAppSlug =
		input.selection.kind === 'app' ? input.selection.appSlug : null
	if (selectedAppSlug != null) {
		const app =
			input.apps.find(
				(entry) => entry.slug === selectedAppSlug && !isBuiltInApp(entry),
			) ?? null
		return {
			selectedApp: app,
			highlightedConnectionName: null as string | null,
			missingKind: app ? null : ('integration' as const),
		}
	}
	const connectionName =
		input.selection.kind === 'connection'
			? input.selection.connectionName
			: null
	if (connectionName == null) {
		return {
			selectedApp: null,
			highlightedConnectionName: null,
			missingKind: null,
		}
	}
	const connection = input.integrations.find(
		(entry) => entry.name === connectionName,
	)
	if (!connection) {
		return {
			selectedApp: null,
			highlightedConnectionName: connectionName,
			missingKind: 'connection' as const,
		}
	}
	const app = findAppForConnection(input.apps, connection)
	return {
		selectedApp: app,
		highlightedConnectionName: connectionName,
		missingKind: app ? null : ('connection' as const),
	}
}

export function filterOauthApps(
	apps: ReadonlyArray<AccountOauthAppListItem>,
	query: string,
) {
	return apps.filter((app) =>
		matchesSearchQuery(query, [
			app.slug,
			app.provider,
			app.label,
			app.clientId,
			app.tokenUrl,
			app.authorizeUrl,
			app.apiBaseUrl,
			...app.connections.map((connection) => connection.name),
			...app.connections.map((connection) => connection.accountLabel),
		]),
	)
}

export const dangerButtonCss = getDangerPillCss({ size: 'sm' })

export function formatList(values: Array<string> | null | undefined) {
	if (!values || values.length === 0) return 'None'
	return values.join(', ')
}

export function formatOptional(value: string | null | undefined) {
	return value?.trim() ? value : 'None'
}

export type ConnectionStatusLabel =
	| 'Needs you'
	| 'Service issue'
	| 'Connected'
	| 'Needs setup'

export function connectActionLabel(status: ConnectionStatusLabel) {
	if (status === 'Needs setup') return 'Connect'
	return 'Reconnect'
}

export function connectionStatusLabel(integration: AccountIntegrationListItem) {
	const failure = integration.lastAuthFailure
	if (failure) {
		return failure.who === 'you' ? 'Needs you' : 'Service issue'
	}
	return integration.authorization?.authorizeUrl ? 'Connected' : 'Needs setup'
}

export function shouldShowReconnectAction(
	integration: AccountIntegrationListItem,
) {
	if (!integration.lastAuthFailure) return true
	return integration.lastAuthFailure.who === 'you'
}

export function hostFromUrl(url: string | null | undefined) {
	if (!url) return null
	try {
		return new URL(url).hostname || null
	} catch {
		return null
	}
}
