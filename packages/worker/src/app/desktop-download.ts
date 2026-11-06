/**
 * Shareable desktop install entry point helpers.
 *
 * Canonical downloads live on `kody-hq/kody-desktop` releases. `/download` is an
 * unlisted redirect that prefers the visitor's platform installer asset and
 * falls back to the latest release page.
 */

export const desktopReleasesLatestUrl =
	'https://github.com/kody-hq/kody-desktop/releases/latest'

export const desktopReleaseLatestDownloadBase =
	'https://github.com/kody-hq/kody-desktop/releases/latest/download'

export const desktopReleaseDownloadBase =
	'https://github.com/kody-hq/kody-desktop/releases/download'

export type DesktopPlatform = 'mac' | 'win' | 'linux'
export type DesktopArch = 'arm64' | 'x64'

export type DesktopDownloadTarget = {
	platform: DesktopPlatform
	arch: DesktopArch
}

export type DesktopInstallerAsset = {
	version: string
	assetName: string
}

const installerExtension: Record<DesktopPlatform, string> = {
	mac: '.dmg',
	win: '.exe',
	linux: '.AppImage',
}

export function desktopUpdaterFeedName(target: DesktopDownloadTarget): string {
	const { platform, arch } = target
	if (platform === 'mac') return `latest-${arch}-mac.yml`
	if (platform === 'win') return `latest-${arch}.yml`
	if (arch === 'x64') return 'latest-x64-linux.yml'
	return 'latest-arm64-linux-arm64.yml'
}

export function desktopUpdaterFeedUrl(target: DesktopDownloadTarget): string {
	return `${desktopReleaseLatestDownloadBase}/${desktopUpdaterFeedName(target)}`
}

/**
 * Tag-specific asset URLs stay valid after a newer release becomes latest, so
 * a cached `/download` Location cannot 404 when the feed moves forward.
 */
export function desktopAssetDownloadUrl(asset: DesktopInstallerAsset): string {
	return `${desktopReleaseDownloadBase}/v${asset.version}/${asset.assetName}`
}

/**
 * Resolve a Mac/Win/Linux + arch target from query overrides and User-Agent.
 * Returns null when the visitor's platform cannot be inferred.
 */
export function detectDesktopDownloadTarget(input: {
	userAgent?: string | null
	platform?: string | null
	arch?: string | null
}): DesktopDownloadTarget | null {
	const platform =
		normalizePlatform(input.platform) ?? detectPlatform(input.userAgent)
	if (!platform) return null
	const arch =
		normalizeArch(input.arch) ?? detectArch(input.userAgent, platform)
	return { platform, arch }
}

export function parseElectronUpdaterVersion(yml: string): string | null {
	const match = /^\s*version:\s*(\S+)\s*$/m.exec(yml)
	const version = match?.[1]
	if (!version) return null
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return null
	return version
}

export function parseElectronUpdaterAssetNames(yml: string): string[] {
	const names: string[] = []
	for (const match of yml.matchAll(/^\s*-\s*url:\s*(\S+)\s*$/gm)) {
		const name = match[1]
		if (name) names.push(name)
	}
	const pathMatch = /^\s*path:\s*(\S+)\s*$/m.exec(yml)
	if (pathMatch?.[1] && !names.includes(pathMatch[1])) names.push(pathMatch[1])
	return names
}

export function pickDesktopInstallerAsset(
	yml: string,
	platform: DesktopPlatform,
): DesktopInstallerAsset | null {
	const version = parseElectronUpdaterVersion(yml)
	if (!version) return null
	const extension = installerExtension[platform]
	const assetName = parseElectronUpdaterAssetNames(yml).find((name) =>
		name.endsWith(extension),
	)
	if (!assetName) return null
	return { version, assetName }
}

function normalizePlatform(
	value: string | null | undefined,
): DesktopPlatform | null {
	if (!value) return null
	const normalized = value.trim().toLowerCase()
	if (normalized === 'mac' || normalized === 'macos' || normalized === 'darwin')
		return 'mac'
	if (
		normalized === 'win' ||
		normalized === 'windows' ||
		normalized === 'win32'
	)
		return 'win'
	if (normalized === 'linux') return 'linux'
	return null
}

function normalizeArch(value: string | null | undefined): DesktopArch | null {
	if (!value) return null
	const normalized = value.trim().toLowerCase()
	if (
		normalized === 'arm64' ||
		normalized === 'aarch64' ||
		normalized === 'arm'
	)
		return 'arm64'
	if (
		normalized === 'x64' ||
		normalized === 'amd64' ||
		normalized === 'x86_64' ||
		normalized === 'intel'
	)
		return 'x64'
	return null
}

function detectPlatform(
	userAgent: string | null | undefined,
): DesktopPlatform | null {
	const ua = (userAgent ?? '').slice(0, 512).toLowerCase()
	if (!ua) return null
	if (ua.includes('android')) return null
	if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod'))
		return null
	if (ua.includes('mac os x') || ua.includes('macintosh')) return 'mac'
	if (ua.includes('windows')) return 'win'
	if (ua.includes('linux') || ua.includes('cros')) return 'linux'
	return null
}

function detectArch(
	userAgent: string | null | undefined,
	platform: DesktopPlatform,
): DesktopArch {
	const ua = (userAgent ?? '').slice(0, 512).toLowerCase()
	if (
		ua.includes('arm64') ||
		ua.includes('aarch64') ||
		ua.includes('apple silicon')
	)
		return 'arm64'
	if (
		ua.includes('x86_64') ||
		ua.includes('amd64') ||
		ua.includes('win64') ||
		/\bx64\b/.test(ua)
	)
		return 'x64'
	// Safari and Chrome still say "Intel Mac OS X" on Apple silicon, so Mac
	// defaults to arm64. Pass ?arch=x64 for Intel Macs.
	if (platform === 'mac') return 'arm64'
	return 'x64'
}
