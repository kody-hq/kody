import { expect, test } from 'vitest'
import {
	desktopAssetDownloadUrl,
	detectDesktopDownloadTarget,
	pickDesktopInstallerAsset,
	versionFromDesktopReleaseTag,
} from './desktop-download.ts'
import { createDesktopDownloadHandler } from './handlers/desktop-download.ts'

const latestReleasesPage =
	'https://github.com/kody-hq/kody-desktop/releases/latest'
const macArmDmgUrl =
	'https://github.com/kody-hq/kody-desktop/releases/download/v0.1.26/Kody-0.1.26-mac-arm64.dmg'

const macRelease = {
	tag_name: 'v0.1.26',
	assets: [
		{ name: 'Kody-0.1.26-mac-arm64.zip' },
		{ name: 'Kody-0.1.26-mac-arm64.dmg' },
		{ name: 'Kody-0.1.26-mac-x64.dmg' },
		{ name: 'latest-arm64-mac.yml' },
	],
}

test('detects explicit Mac arch overrides and rejects ambiguous Mac agents', () => {
	expect(
		detectDesktopDownloadTarget({
			userAgent:
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
		}),
	).toBeNull()
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
	expect(
		detectDesktopDownloadTarget({
			userAgent:
				'Mozilla/5.0 (Macintosh; ARM64 Mac OS X 14_0) AppleWebKit/605.1.15',
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

test('picks tag-specific installer assets from the GitHub latest release', () => {
	expect(versionFromDesktopReleaseTag('v0.1.26')).toBe('0.1.26')
	expect(versionFromDesktopReleaseTag('desktop-demo')).toBeNull()
	expect(
		pickDesktopInstallerAsset(macRelease, { platform: 'mac', arch: 'arm64' }),
	).toEqual({
		version: '0.1.26',
		assetName: 'Kody-0.1.26-mac-arm64.dmg',
	})
	expect(
		desktopAssetDownloadUrl({
			version: '0.1.26',
			assetName: 'Kody-0.1.26-mac-arm64.dmg',
		}),
	).toBe(macArmDmgUrl)
})

test('download handler redirects to the matched installer or the releases page', async () => {
	const handler = createDesktopDownloadHandler({
		fetchLatestRelease: async () => macRelease,
	})

	const asset = await handler({
		request: new Request('https://kody.codes/download?platform=mac&arch=arm64'),
	})
	expect(asset.status).toBe(302)
	expect(asset.headers.get('Location')).toBe(macArmDmgUrl)
	expect(asset.headers.get('Cache-Control')).toBe('private, max-age=300')
	expect(asset.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')

	const page = await handler({
		request: new Request('https://kody.codes/download?page=1'),
	})
	expect(page.headers.get('Location')).toBe(latestReleasesPage)
	expect(page.headers.get('Cache-Control')).toBe('private, no-store')

	const unknown = await handler({
		request: new Request('https://kody.codes/download', {
			headers: { 'user-agent': 'curl/8.0' },
		}),
	})
	expect(unknown.headers.get('Location')).toBe(latestReleasesPage)
	expect(unknown.headers.get('Cache-Control')).toBe('private, no-store')

	const missingAsset = createDesktopDownloadHandler({
		fetchLatestRelease: async () => ({
			tag_name: 'v0.1.26',
			assets: [{ name: 'latest-arm64-mac.yml' }],
		}),
	})
	const missing = await missingAsset({
		request: new Request('https://kody.codes/download?platform=win&arch=x64'),
	})
	expect(missing.headers.get('Location')).toBe(latestReleasesPage)
	expect(missing.headers.get('Cache-Control')).toBe('private, no-store')
})
