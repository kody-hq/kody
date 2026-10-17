import { createListDetailLinks } from '#client/list-detail-route.ts'
import { matchesSearchQuery } from '#client/search-filter.ts'
import { type AdminPlatformIntegrationApp } from '#universal/loader-data.ts'
export const platformIntegrationsRoute = createListDetailLinks(
	'/admin/platform-integrations',
)
export type ActionState =
	| 'idle'
	| 'saving-form'
	| 'toggling-enabled'
	| 'toggling-visibility'
	| 'deleting'
export type TokenExchangeStyleOption =
	| 'default'
	| 'form'
	| 'basic-json'
	| 'basic-form'

export function filterApps(
	apps: Array<AdminPlatformIntegrationApp>,
	search: string,
) {
	return apps.filter((app) =>
		matchesSearchQuery(search, [app.slug, app.provider, app.label]),
	)
}

export function joinList(items: Array<string>): string {
	return items.join(', ')
}

export function splitListInput(raw: string): Array<string> {
	return raw
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean)
}

export function formatExtraAuthorizeParams(
	params: Record<string, string>,
): string {
	return Object.entries(params)
		.map(([key, value]) => `${key}=${value}`)
		.join('\n')
}

export function parseExtraAuthorizeParams(raw: string): Record<string, string> {
	const result: Record<string, string> = {}
	for (const line of raw.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed) continue
		const equalsIndex = trimmed.indexOf('=')
		if (equalsIndex === -1) continue
		const key = trimmed.slice(0, equalsIndex).trim()
		const value = trimmed.slice(equalsIndex + 1).trim()
		if (key) result[key] = value
	}
	return result
}

export function formatTokenExchangeStyle(
	value: AdminPlatformIntegrationApp['tokenExchangeStyle'],
): TokenExchangeStyleOption {
	if (value === 'form' || value === 'basic-json' || value === 'basic-form') {
		return value
	}
	return 'default'
}
