import type { ComponentStatus } from './status-types.ts'

/** Public PNG for each overall status. Distinct paths so a tab that already
 * loaded the operational icon will actually swap when an incident opens. */
export function statusFaviconPath(status: ComponentStatus): string {
	switch (status) {
		case 'operational':
			return '/favicon-operational.png'
		case 'down':
			return '/favicon-down.png'
		case 'unknown':
			return '/favicon-unknown.png'
		default: {
			status satisfies never
			throw new Error(`Unknown overall status: ${String(status)}`)
		}
	}
}

export function renderFaviconLinks(status: ComponentStatus): string {
	const href = statusFaviconPath(status)
	return `<link rel="icon" href="${href}" type="image/png" sizes="192x192" />
<link rel="apple-touch-icon" href="${href}" />`
}

/** Absolute Location for `GET /favicon.ico` so naive icon fetches follow
 * the current overall status. */
export function faviconIcoRedirectLocation(
	requestUrl: string,
	status: ComponentStatus,
): string {
	return new URL(statusFaviconPath(status), requestUrl).href
}
