import { type DeviceAuthorizationRow } from '#worker/oauth-device/store.ts'

/**
 * The stored half of a package-app visitor device sign-in (ADR 0094): what
 * `oauth_device_authorizations.request_json` holds for `kind = 'package_app'`
 * rows, and the authorize query such a row stands for.
 */

export type PackageAppDeviceRequest = {
	v: 1
	state: string | null
	codeChallenge: string
	/** Plain label for the browser that asked, e.g. "Chrome 80 on Linux". */
	requester: string
	rememberMe: boolean
}

function versionOf(token: string, pattern: RegExp) {
	return pattern.exec(token)?.[1]?.split('.')[0] ?? null
}

/**
 * A short, human label for the browser that asked, shown on the approval
 * screen. It is informative only: user agents are self-reported.
 */
export function describeRequestingBrowser(userAgent: string | null) {
	const ua = (userAgent ?? '').slice(0, 512)
	if (!ua) return 'An unknown browser'
	const chrome = versionOf(ua, /(?:Chrome|Chromium|CriOS)\/([\d.]+)/)
	const firefox = versionOf(ua, /(?:Firefox|FxiOS)\/([\d.]+)/)
	const edge = versionOf(ua, /Edg(?:e|A|iOS)?\/([\d.]+)/)
	const safari = versionOf(ua, /Version\/([\d.]+).*Safari\//)
	const engine = edge
		? `Edge ${edge}`
		: chrome
			? `Chrome ${chrome}`
			: firefox
				? `Firefox ${firefox}`
				: safari
					? `Safari ${safari}`
					: 'A browser'
	if (/Kindle|Silk\//.test(ua)) {
		return `Kindle browser (${engine})`
	}
	const os = /CrOS/.test(ua)
		? 'ChromeOS'
		: /Android/.test(ua)
			? 'Android'
			: /iPhone|iPad|iPod/.test(ua)
				? 'iOS'
				: /Windows/.test(ua)
					? 'Windows'
					: /Mac OS X|Macintosh/.test(ua)
						? 'macOS'
						: /Linux/.test(ua)
							? 'Linux'
							: null
	return os ? `${engine} on ${os}` : engine
}

export function parsePackageAppDeviceRequest(row: DeviceAuthorizationRow) {
	try {
		const parsed = JSON.parse(
			row.request_json ?? '',
		) as Partial<PackageAppDeviceRequest>
		if (parsed?.v !== 1 || typeof parsed.codeChallenge !== 'string') {
			return null
		}
		return {
			v: 1,
			state: typeof parsed.state === 'string' ? parsed.state : null,
			codeChallenge: parsed.codeChallenge,
			requester:
				typeof parsed.requester === 'string'
					? parsed.requester
					: 'An unknown browser',
			rememberMe: parsed.rememberMe === true,
		} satisfies PackageAppDeviceRequest
	} catch {
		return null
	}
}

/** What the approval (consent) screen shows about the asking device. */
export function packageAppDeviceRequester(row: DeviceAuthorizationRow) {
	return parsePackageAppDeviceRequest(row)?.requester ?? 'An unknown browser'
}

/** The authorize query a package-app device row stands for. */
export function packageAppDeviceAuthorizeQuery(row: DeviceAuthorizationRow) {
	const request = parsePackageAppDeviceRequest(row)
	return {
		clientIdRaw: row.client_id,
		redirectUri: row.resource,
		state: request?.state ?? null,
		codeChallenge: request?.codeChallenge ?? null,
		codeChallengeMethod: 'S256',
		scopeRaw: row.scope,
		responseType: 'code',
	}
}
