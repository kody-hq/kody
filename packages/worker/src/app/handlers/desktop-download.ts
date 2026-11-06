import {
	desktopAssetDownloadUrl,
	desktopReleasesLatestUrl,
	desktopUpdaterFeedUrl,
	detectDesktopDownloadTarget,
	pickDesktopInstallerAsset,
	type DesktopDownloadTarget,
	type DesktopInstallerAsset,
} from '#app/desktop-download.ts'

const redirectHeaders = {
	'Cache-Control': 'public, max-age=300',
	'X-Robots-Tag': 'noindex, nofollow',
} as const

export function createDesktopDownloadHandler(
	options: {
		fetchFeed?: (url: string) => Promise<string | null>
	} = {},
) {
	const fetchFeed = options.fetchFeed ?? fetchDesktopUpdaterFeed
	return async ({ request }: { request: Request }) => {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method not allowed', { status: 405 })
		}
		const url = new URL(request.url)
		if (url.searchParams.get('page') === '1') {
			return redirect(desktopReleasesLatestUrl)
		}
		const target = detectDesktopDownloadTarget({
			userAgent: request.headers.get('user-agent'),
			platform: url.searchParams.get('platform') ?? url.searchParams.get('os'),
			arch: url.searchParams.get('arch'),
		})
		if (!target) return redirect(desktopReleasesLatestUrl)
		const asset = await resolveInstallerAsset(target, fetchFeed)
		if (!asset) return redirect(desktopReleasesLatestUrl)
		return redirect(desktopAssetDownloadUrl(asset))
	}
}

async function resolveInstallerAsset(
	target: DesktopDownloadTarget,
	fetchFeed: (url: string) => Promise<string | null>,
): Promise<DesktopInstallerAsset | null> {
	try {
		const yml = await fetchFeed(desktopUpdaterFeedUrl(target))
		if (!yml) return null
		return pickDesktopInstallerAsset(yml, target.platform)
	} catch {
		return null
	}
}

async function fetchDesktopUpdaterFeed(url: string): Promise<string | null> {
	const response = await fetch(url, {
		headers: {
			Accept: 'text/yaml, text/plain;q=0.9, */*;q=0.8',
			'User-Agent': 'kody.codes-download',
		},
		redirect: 'follow',
		signal: AbortSignal.timeout(2_500),
	})
	if (!response.ok) return null
	return await response.text()
}

function redirect(location: string) {
	return new Response(null, {
		status: 302,
		headers: {
			...redirectHeaders,
			Location: location,
		},
	})
}
