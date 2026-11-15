import {
	desktopAssetDownloadUrl,
	desktopInstallerAsset,
	desktopReleasesLatestUrl,
	detectDesktopDownloadTarget,
	versionFromDesktopLatestLocation,
} from '#app/desktop-download.ts'

const assetRedirectHeaders = {
	'Cache-Control': 'private, max-age=300',
	'X-Robots-Tag': 'noindex, nofollow',
} as const

const fallbackRedirectHeaders = {
	'Cache-Control': 'private, no-store',
	'X-Robots-Tag': 'noindex, nofollow',
} as const

export function createDesktopDownloadHandler(
	options: {
		fetchLatestVersion?: () => Promise<string | null>
	} = {},
) {
	const fetchLatestVersion =
		options.fetchLatestVersion ?? fetchDesktopLatestVersion
	return async ({ request }: { request: Request }) => {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method not allowed', { status: 405 })
		}
		const url = new URL(request.url)
		if (url.searchParams.get('page') === '1') {
			return redirect(desktopReleasesLatestUrl, fallbackRedirectHeaders)
		}
		const target = detectDesktopDownloadTarget({
			userAgent: request.headers.get('user-agent'),
			platform: url.searchParams.get('platform') ?? url.searchParams.get('os'),
			arch: url.searchParams.get('arch'),
		})
		if (!target) {
			return redirect(desktopReleasesLatestUrl, fallbackRedirectHeaders)
		}
		const version = await fetchLatestVersion().catch(() => null)
		if (!version) {
			return redirect(desktopReleasesLatestUrl, fallbackRedirectHeaders)
		}
		return redirect(
			desktopAssetDownloadUrl(desktopInstallerAsset(version, target)),
			assetRedirectHeaders,
		)
	}
}

async function fetchDesktopLatestVersion(): Promise<string | null> {
	const response = await fetch(desktopReleasesLatestUrl, {
		method: 'HEAD',
		headers: { 'User-Agent': 'kody.codes-download' },
		redirect: 'manual',
		signal: AbortSignal.timeout(5_000),
	})
	return versionFromDesktopLatestLocation(response.headers.get('Location'))
}

function redirect(location: string, headers: Record<string, string>) {
	return new Response(null, {
		status: 302,
		headers: {
			...headers,
			Location: location,
		},
	})
}
