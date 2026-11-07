import {
	desktopAssetDownloadUrl,
	desktopLatestReleaseApiUrl,
	desktopReleasesLatestUrl,
	detectDesktopDownloadTarget,
	pickDesktopInstallerAsset,
	type DesktopDownloadTarget,
	type DesktopGithubRelease,
	type DesktopInstallerAsset,
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
		fetchLatestRelease?: () => Promise<DesktopGithubRelease | null>
	} = {},
) {
	const fetchLatestRelease =
		options.fetchLatestRelease ?? fetchDesktopLatestRelease
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
		const asset = await resolveInstallerAsset(target, fetchLatestRelease)
		if (!asset) {
			return redirect(desktopReleasesLatestUrl, fallbackRedirectHeaders)
		}
		return redirect(desktopAssetDownloadUrl(asset), assetRedirectHeaders)
	}
}

async function resolveInstallerAsset(
	target: DesktopDownloadTarget,
	fetchLatestRelease: () => Promise<DesktopGithubRelease | null>,
): Promise<DesktopInstallerAsset | null> {
	try {
		const release = await fetchLatestRelease()
		if (!release) return null
		return pickDesktopInstallerAsset(release, target)
	} catch {
		return null
	}
}

async function fetchDesktopLatestRelease(): Promise<DesktopGithubRelease | null> {
	const response = await fetch(desktopLatestReleaseApiUrl, {
		headers: {
			Accept: 'application/vnd.github+json',
			'User-Agent': 'kody.codes-download',
			'X-GitHub-Api-Version': '2022-11-28',
		},
		redirect: 'follow',
		signal: AbortSignal.timeout(5_000),
	})
	if (!response.ok) return null
	const data = (await response.json()) as {
		tag_name?: unknown
		assets?: unknown
	}
	if (typeof data.tag_name !== 'string' || !Array.isArray(data.assets)) {
		return null
	}
	const assets = data.assets.flatMap((asset) => {
		if (!asset || typeof asset !== 'object') return []
		const name = (asset as { name?: unknown }).name
		return typeof name === 'string' ? [{ name }] : []
	})
	return { tag_name: data.tag_name, assets }
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
