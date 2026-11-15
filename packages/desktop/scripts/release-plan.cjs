const { appendFileSync, readFileSync } = require('node:fs')

const targets = [
	{ platform: 'mac', arch: 'arm64', runner: 'macos-15' },
	{ platform: 'mac', arch: 'x64', runner: 'macos-15-intel' },
	{ platform: 'win', arch: 'x64', runner: 'windows-latest' },
	{ platform: 'win', arch: 'arm64', runner: 'windows-11-arm' },
	{ platform: 'linux', arch: 'x64', runner: 'ubuntu-24.04' },
	{ platform: 'linux', arch: 'arm64', runner: 'ubuntu-24.04-arm' },
]
function releasePlan(env) {
	const provider = env.DESKTOP_WINDOWS_SIGNING_PROVIDER || 'certificate'
	if (!['certificate', 'azure'].includes(provider))
		throw new Error('Unsupported Windows signing provider')
	const required = [
		'DESKTOP_MAC_CERTIFICATE_BASE64',
		'DESKTOP_MAC_CERTIFICATE_PASSWORD',
		'DESKTOP_APPLE_API_KEY_BASE64',
		'DESKTOP_APPLE_API_KEY_ID',
		'DESKTOP_APPLE_API_ISSUER',
		'DESKTOP_RELEASE_TOKEN',
		'DESKTOP_WINDOWS_PUBLISHER',
		...(provider === 'azure'
			? [
					'DESKTOP_AZURE_TENANT_ID',
					'DESKTOP_AZURE_CLIENT_ID',
					'DESKTOP_AZURE_CLIENT_SECRET',
					'DESKTOP_AZURE_ENDPOINT',
					'DESKTOP_AZURE_ACCOUNT',
					'DESKTOP_AZURE_PROFILE',
				]
			: [
					'DESKTOP_WINDOWS_CERTIFICATE_BASE64',
					'DESKTOP_WINDOWS_CERTIFICATE_PASSWORD',
				]),
	]
	return {
		matrix: { include: targets },
		missing: required.filter((name) => !env[name]),
	}
}
// Windows installs are MSIX packages that App Installer updates from the
// stable, unversioned .appinstaller file, so they carry no electron-updater
// feed or blockmap. Every Windows target trusts the same signer certificate.
const windowsSignerCertificate = 'Kody-win-signer.cer'
function windowsAppInstallerName(arch) {
	return `Kody-win-${arch}.appinstaller`
}
function targetAssetNames(version, { platform, arch }) {
	const os = platform
	const checks = [
		`SHA256SUMS-${os}-${arch}.txt`,
		`build-info-${os}-${arch}.json`,
	]
	if (platform === 'win')
		return [
			...checks,
			`Kody-${version}-win-${arch}.msix`,
			windowsAppInstallerName(arch),
			windowsSignerCertificate,
		]
	if (platform === 'linux')
		return [
			`latest-${arch}-linux${arch === 'x64' ? '' : `-${arch}`}.yml`,
			...checks,
			...linuxInstallerNames(version, arch),
		]
	return [
		`latest-${arch}-mac.yml`,
		...checks,
		...['dmg', 'zip'].flatMap((extension) => {
			const name = `Kody-${version}-mac-${arch}.${extension}`
			return [name, `${name}.blockmap`]
		}),
	]
}
// AppImages embed their blockmap and are the electron-updater install. The
// .deb is listed in the same feed but updates by downloading it again.
function linuxInstallerNames(version, arch) {
	return [
		`Kody-${version}-linux-${arch === 'x64' ? 'x86_64' : arch}.AppImage`,
		`Kody-${version}-linux-${arch === 'x64' ? 'amd64' : arch}.deb`,
	]
}
function releaseAssetNames(version) {
	return [
		...new Set(
			releasePlan({}).matrix.include.flatMap((target) =>
				targetAssetNames(version, target),
			),
		),
	]
}
function uploadedAssetNames(release) {
	return (release?.assets ?? [])
		.filter(
			(asset) => (asset.state ?? 'uploaded') === 'uploaded' && asset.size > 0,
		)
		.map((asset) => asset.name)
}
// A matching draft already holds every asset of some targets when an earlier
// attempt failed after they uploaded. Build only the rest.
function pendingTargets({ include, version, sha, releases = [] }) {
	const draft = releases.find(
		(release) => release.draft && release.tag_name === `v${version}`,
	)
	if (!draft) return include
	try {
		assertDraft(
			{ ...draft, isDraft: draft.draft },
			sha,
			releaseAssetNames(version),
		)
	} catch {
		return include
	}
	const uploaded = uploadedAssetNames(draft)
	return include.filter(
		(target) =>
			!targetAssetNames(version, target).every((name) =>
				uploaded.includes(name),
			),
	)
}
function releaseNotes(sha) {
	return `Source: https://github.com/kody-hq/kody/commit/${sha}
Platforms: all`
}
function assertDraft(draft, sha, assetNames) {
	if (!draft.isDraft)
		throw new Error(
			'Version already published. Bump the desktop version first.',
		)
	if (draft.body !== releaseNotes(sha))
		throw new Error(
			'Draft source or platforms differ. Use a new version or remove the stale draft before retrying.',
		)
	if (draft.assets.some((asset) => !assetNames.includes(asset.name)))
		throw new Error(
			'Draft contains assets outside this release plan. Remove the stale draft before retrying.',
		)
}
if (require.main === module) {
	if (process.argv.includes('--check-draft')) {
		assertDraft(
			JSON.parse(readFileSync(0, 'utf8')),
			process.env.SOURCE_SHA,
			releaseAssetNames(process.env.RELEASE_VERSION),
		)
	} else if (process.argv.includes('--notes')) {
		process.stdout.write(releaseNotes(process.env.SOURCE_SHA))
	} else {
		const plan = releasePlan(process.env)
		const include = pendingTargets({
			include: plan.matrix.include,
			version: process.env.RELEASE_VERSION,
			sha: process.env.SOURCE_SHA,
			releases: process.env.RELEASES_FILE
				? JSON.parse(readFileSync(process.env.RELEASES_FILE, 'utf8')).flat()
				: [],
		})
		for (const target of plan.matrix.include)
			if (!include.includes(target))
				console.log(
					`${target.platform} ${target.arch} assets are already on the draft; skipping its build.`,
				)
		appendFileSync(
			process.env.GITHUB_OUTPUT,
			`matrix=${JSON.stringify({ include })}\npending=${include.length > 0}\n`,
		)
		if (plan.missing.length) {
			console.error(
				`Configure desktop-release environment: ${plan.missing.join(', ')}`,
			)
			process.exitCode = 1
		}
	}
}
module.exports = {
	releasePlan,
	linuxInstallerNames,
	windowsAppInstallerName,
	windowsSignerCertificate,
	releaseNotes,
	assertDraft,
	targetAssetNames,
	releaseAssetNames,
	uploadedAssetNames,
	pendingTargets,
}
