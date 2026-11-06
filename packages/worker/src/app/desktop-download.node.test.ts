import { expect, test } from 'vitest'
import {
	desktopAssetDownloadUrl,
	desktopReleasesLatestUrl,
	desktopUpdaterFeedName,
	desktopUpdaterFeedUrl,
	detectDesktopDownloadTarget,
	parseElectronUpdaterAssetNames,
	parseElectronUpdaterVersion,
	pickDesktopInstallerAsset,
} from './desktop-download.ts'
import { createDesktopDownloadHandler } from './handlers/desktop-download.ts'

const macArm64Feed = `version: 0.1.26
files:
  - url: Kody-0.1.26-mac-arm64.zip
  - url: Kody-0.1.26-mac-arm64.dmg
path: Kody-0.1.26-mac-arm64.zip
`

test('detects Mac arm64 from an Apple silicon user agent and query overrides', () => {
	expect(
		detectDesktopDownloadTarget({
			userAgent:
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
		}),
	).toEqual({ platform: 'mac', arch: 'arm64' })
	expect(
		detectDesktopDownloadTarget({
			userAgent:
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			arch: 'x64',
		}),
	).toEqual({ platform: 'mac', arch: 'x64' })
	expect(
		detectDesktopDownloadTarget({
			userAgent: null,
			platform: 'macos',
			arch: 'aarch64',
		}),
	).toEqual({ platform: 'mac', arch: 'arm64' })
})

test('detects Windows and Linux targets and rejects mobile agents', () => {
	expect(
		detectDesktopDownloadTarget({
			userAgent:
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
		}),
	).toEqual({ platform: 'win', arch: 'x64' })
	expect(
		detectDesktopDownloadTarget({
			userAgent:
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0',
		}),
	).toEqual({ platform: 'linux', arch: 'x64' })
	expect(
		detectDesktopDownloadTarget({
			userAgent:
				'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile',
		}),
	).toBeNull()
	expect(detectDesktopDownloadTarget({ userAgent: null })).toBeNull()
})

test('maps updater feeds to tag-specific installer URLs that survive a newer latest', () => {
	expect(desktopUpdaterFeedName({ platform: 'mac', arch: 'arm64' })).toBe(
		'latest-arm64-mac.yml',
	)
	expect(desktopUpdaterFeedName({ platform: 'win', arch: 'x64' })).toBe(
		'latest-x64.yml',
	)
	expect(desktopUpdaterFeedName({ platform: 'linux', arch: 'arm64' })).toBe(
		'latest-arm64-linux-arm64.yml',
	)
	expect(parseElectronUpdaterVersion(macArm64Feed)).toBe('0.1.26')
	expect(parseElectronUpdaterAssetNames(macArm64Feed)).toEqual([
		'Kody-0.1.26-mac-arm64.zip',
		'Kody-0.1.26-mac-arm64.dmg',
	])
	expect(pickDesktopInstallerAsset(macArm64Feed, 'mac')).toEqual({
		version: '0.1.26',
		assetName: 'Kody-0.1.26-mac-arm64.dmg',
	})
	expect(desktopUpdaterFeedUrl({ platform: 'mac', arch: 'arm64' })).toBe(
		'https://github.com/kody-hq/kody-desktop/releases/latest/download/latest-arm64-mac.yml',
	)
	expect(
		desktopAssetDownloadUrl({
			version: '0.1.26',
			assetName: 'Kody-0.1.26-mac-arm64.dmg',
		}),
	).toBe(
		'https://github.com/kody-hq/kody-desktop/releases/download/v0.1.26/Kody-0.1.26-mac-arm64.dmg',
	)
})

test('download handler redirects to the matched installer or the releases page', async () => {
	const feeds = new Map([
		[desktopUpdaterFeedUrl({ platform: 'mac', arch: 'arm64' }), macArm64Feed],
	])
	const handler = createDesktopDownloadHandler({
		fetchFeed: async (url) => feeds.get(url) ?? null,
	})

	const asset = await handler({
		request: new Request('https://kody.codes/download?platform=mac&arch=arm64'),
	})
	expect(asset.status).toBe(302)
	expect(asset.headers.get('Location')).toBe(
		desktopAssetDownloadUrl({
			version: '0.1.26',
			assetName: 'Kody-0.1.26-mac-arm64.dmg',
		}),
	)
	expect(asset.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')

	const page = await handler({
		request: new Request('https://kody.codes/download?page=1'),
	})
	expect(page.headers.get('Location')).toBe(desktopReleasesLatestUrl)

	const unknown = await handler({
		request: new Request('https://kody.codes/download', {
			headers: { 'user-agent': 'curl/8.0' },
		}),
	})
	expect(unknown.headers.get('Location')).toBe(desktopReleasesLatestUrl)

	const missingFeed = await handler({
		request: new Request('https://kody.codes/download?platform=win&arch=x64'),
	})
	expect(missingFeed.headers.get('Location')).toBe(desktopReleasesLatestUrl)
})
