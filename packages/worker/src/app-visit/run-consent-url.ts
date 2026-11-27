/**
 * Where a person confirms "Run as me" for an app, and how a served response
 * says that confirmation is still needed. Shared by the browser visit path and
 * `appFetch`, which reports the link instead of redirecting.
 */
import {
	buildPackageAppOpenPath,
	packageAppHostEntryQueryParam,
} from '@kody-internal/shared/public-urls.ts'
import { packageAppHandoffQueryParam } from '#app/package-app-handoff.ts'

export const packageAppRunConsentPath = '/oauth/package-app/run-as-me'
export const packageAppRunConsentRequiredHeader = 'X-Kody-Run-As-Me'

export function buildPackageAppRunConsentUrl(baseUrl: string, entry: URL) {
	const location = new URL(packageAppRunConsentPath, baseUrl)
	location.searchParams.set('returnTo', `${entry.pathname}${entry.search}`)
	return location
}

/**
 * The link a person opens once to confirm "Run as me" for an app. After
 * confirming they land on the app at `packagePath`.
 */
export function packageAppRunConsentUrl(input: {
	baseUrl: string
	packagePath: { username: string; kodyId: string; restPath: string }
	search?: string
	fromAppHost?: boolean
}) {
	const { packagePath } = input
	const entry = new URL(
		buildPackageAppOpenPath({
			...packagePath,
			restPath: packagePath.restPath === '/' ? null : packagePath.restPath,
		}),
		input.baseUrl,
	)
	entry.search = input.search ?? ''
	entry.searchParams.delete(packageAppHandoffQueryParam)
	if (input.fromAppHost)
		entry.searchParams.set(packageAppHostEntryQueryParam, '1')
	return buildPackageAppRunConsentUrl(input.baseUrl, entry)
}
