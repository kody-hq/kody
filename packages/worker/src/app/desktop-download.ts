/**
 * Shareable desktop install entry point helpers.
 *
 * Canonical downloads live on `kody-hq/kody-desktop` releases. `/download` is an
 * unlisted redirect that prefers the visitor's platform installer asset and
 * falls back to the latest release page.
 */

export const desktopReleasesLatestUrl =
	'https://github.com/kody-hq/kody-desktop/releases/latest'

export const desktopReleaseDownloadBase =
	'https://github.com/kody-hq/kody-desktop/releases/download'

export const desktopLatestReleaseApiUrl =
	'https://api.github.com/repos/kody-hq/kody-desktop/releases/latest'

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

export type DesktopGithubRelease = {
	tag_name: string
	assets: ReadonlyArray<{ name: string }>
}

const installerExtension: Record<DesktopPlatform, string> = {
	mac: '.dmg',
	win: '.exe',
	linux: '.AppImage',
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
 * Returns null when the visitor's platform or architecture cannot be inferred.
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
	if (!arch) return null
	return { platform, arch }
}

export function versionFromDesktopReleaseTag(tagName: string): string | null {
	if (!tagName.startsWith('v')) return null
	const version = tagName.slice(1)
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return null
	return version
}

export function pickDesktopInstallerAsset(
	release: DesktopGithubRelease,
	target: DesktopDownloadTarget,
): DesktopInstallerAsset | null {
	const version = versionFromDesktopReleaseTag(release.tag_name)
	if (!version) return null
	const os =
		target.platform === 'mac'
			? 'mac'
			: target.platform === 'win'
				? 'win'
				: 'linux'
	const archToken =
		target.platform === 'linux' && target.arch === 'x64'
			? 'x86_64'
			: target.arch
	const assetName = `Kody-${version}-${os}-${archToken}${installerExtension[target.platform]}`
	if (!release.assets.some((asset) => asset.name === assetName)) return null
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
	_platform: DesktopPlatform,
): DesktopArch | null {
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
	// Safari/Chrome still say "Intel Mac OS X" on Apple silicon and omit a
	// reliable arch token, so leave Mac (and other ambiguous agents) unknown
	// and send them to the releases page instead of guessing.
	return null
}
