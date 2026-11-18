import { afterEach, expect, test, vi } from 'vitest'
import {
	desktopAssetDownloadUrl,
	desktopInstallerAsset,
	detectDesktopDownloadTarget,
	versionFromDesktopLatestLocation,
	versionFromDesktopReleaseTag,
} from './desktop-download.ts'
import { createDesktopDownloadHandler } from './handlers/desktop-download.ts'

const latestReleasesPage =
	'https://github.com/kody-hq/kody-desktop/releases/latest'
const macArmDmgUrl =
	'https://github.com/kody-hq/kody-desktop/releases/download/v0.1.26/Kody-0.1.26-mac-arm64.dmg'

afterEach(() => {
	vi.unstubAllGlobals()
})

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

test('reads the latest tag from the releases page redirect', () => {
	expect(versionFromDesktopReleaseTag('v0.1.26')).toBe('0.1.26')
	expect(versionFromDesktopReleaseTag('desktop-demo')).toBeNull()
	expect(
		versionFromDesktopLatestLocation(
			'https://github.com/kody-hq/kody-desktop/releases/tag/v0.1.26',
		),
	).toBe('0.1.26')
	expect(
		versionFromDesktopLatestLocation(
			'/kody-hq/kody-desktop/releases/tag/v0.1.26',
		),
	).toBe('0.1.26')
	expect(
		versionFromDesktopLatestLocation(
			'https://github.com/kody-hq/kody-desktop/releases',
		),
	).toBeNull()
	expect(versionFromDesktopLatestLocation(null)).toBeNull()
})

test('Mac downloads the arch-specific DMG', () => {
	expect(
		desktopInstallerAsset('0.1.26', { platform: 'mac', arch: 'arm64' }),
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

test('Windows downloads the App Installer file that keeps the MSIX updated', () => {
	expect(
		desktopInstallerAsset('0.1.74', { platform: 'win', arch: 'arm64' }),
	).toEqual({ version: '0.1.74', assetName: 'Kody-win-arm64.appinstaller' })
})

test('Linux downloads the AppImage for its architecture', async () => {
	expect(
		desktopInstallerAsset('0.1.83', { platform: 'linux', arch: 'arm64' }),
	).toEqual({
		version: '0.1.83',
		assetName: 'Kody-0.1.83-linux-arm64.AppImage',
	})
	const handler = createDesktopDownloadHandler({
		fetchLatestVersion: async () => '0.1.83',
	})
	const response = await handler({
		request: new Request('https://kody.codes/download', {
			headers: {
				'user-agent':
					'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0',
			},
		}),
	})
	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe(
		'https://github.com/kody-hq/kody-desktop/releases/download/v0.1.83/Kody-0.1.83-linux-x86_64.AppImage',
	)
})

test('resolves the installer while the GitHub REST API is rate limited', async () => {
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (url.startsWith('https://api.github.com/')) {
				return new Response('rate limited', { status: 403 })
			}
			expect(url).toBe(latestReleasesPage)
			expect(init?.redirect).toBe('manual')
			return new Response(null, {
				status: 302,
				headers: {
					Location:
						'https://github.com/kody-hq/kody-desktop/releases/tag/v0.1.83',
				},
			})
		},
	)
	vi.stubGlobal('fetch', fetchMock)
	const response = await createDesktopDownloadHandler()({
		request: new Request('https://kody.codes/download?platform=linux&arch=x64'),
	})
	expect(response.headers.get('Location')).toBe(
		'https://github.com/kody-hq/kody-desktop/releases/download/v0.1.83/Kody-0.1.83-linux-x86_64.AppImage',
	)
	expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('download handler redirects to the matched installer or the releases page', async () => {
	const handler = createDesktopDownloadHandler({
		fetchLatestVersion: async () => '0.1.26',
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

	const unresolved = createDesktopDownloadHandler({
		fetchLatestVersion: async () => {
			throw new Error('network down')
		},
	})
	const missing = await unresolved({
		request: new Request('https://kody.codes/download?platform=win&arch=x64'),
	})
	expect(missing.headers.get('Location')).toBe(latestReleasesPage)
	expect(missing.headers.get('Cache-Control')).toBe('private, no-store')
})
