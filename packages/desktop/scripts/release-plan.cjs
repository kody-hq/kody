const { appendFileSync, readFileSync } = require('node:fs')

const targets = [
	{ platform: 'mac', arch: 'arm64', runner: 'macos-15' },
	{ platform: 'mac', arch: 'x64', runner: 'macos-15-intel' },
	{ platform: 'win', arch: 'x64', runner: 'windows-latest' },
	{ platform: 'win', arch: 'arm64', runner: 'windows-11-arm' },
	{ platform: 'linux', arch: 'x64', runner: 'ubuntu-24.04' },
	{ platform: 'linux', arch: 'arm64', runner: 'ubuntu-24.04-arm' },
]
function releasePlan(scope, env) {
	if (!['mac', 'all'].includes(scope))
		throw new Error('Choose mac or all release platforms.')
	const required = [
		'DESKTOP_MAC_CERTIFICATE_BASE64',
		'DESKTOP_MAC_CERTIFICATE_PASSWORD',
		'DESKTOP_APPLE_API_KEY_BASE64',
		'DESKTOP_APPLE_API_KEY_ID',
		'DESKTOP_APPLE_API_ISSUER',
		'DESKTOP_RELEASE_TOKEN',
	]
	if (scope === 'all') {
		const provider = env.DESKTOP_WINDOWS_SIGNING_PROVIDER || 'certificate'
		if (!['certificate', 'azure'].includes(provider))
			throw new Error('Unsupported Windows signing provider')
		required.push(
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
		)
	}
	return {
		matrix: {
			include: targets.filter(
				(target) => scope === 'all' || target.platform === 'mac',
			),
		},
		missing: required.filter((name) => !env[name]),
	}
}
function targetAssetNames(version, { platform, arch }) {
	const os = platform
	const suffix =
		platform === 'mac'
			? '-mac'
			: platform === 'linux'
				? `-linux${arch === 'x64' ? '' : `-${arch}`}`
				: ''
	const artifactArch = platform === 'linux' && arch === 'x64' ? 'x86_64' : arch
	const extensions =
		platform === 'mac'
			? ['dmg', 'zip']
			: platform === 'win'
				? ['exe']
				: ['AppImage']
	return [
		`latest-${arch}${suffix}.yml`,
		`SHA256SUMS-${os}-${arch}.txt`,
		`build-info-${os}-${arch}.json`,
		...extensions.flatMap((extension) => {
			const name = `Kody-${version}-${os}-${artifactArch}.${extension}`
			return [name, `${name}.blockmap`]
		}),
	]
}
function releaseAssetNames(version, scope) {
	return releasePlan(scope, {}).matrix.include.flatMap((target) =>
		targetAssetNames(version, target),
	)
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
function pendingTargets({ include, version, sha, scope, releases = [] }) {
	const draft = releases.find(
		(release) => release.draft && release.tag_name === `v${version}`,
	)
	if (!draft) return include
	try {
		assertDraft(
			{ ...draft, isDraft: draft.draft },
			sha,
			scope,
			releaseAssetNames(version, scope),
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
function assertFeedCoverage(scope, assets) {
	if (!['mac', 'all'].includes(scope))
		throw new Error('Choose mac or all release platforms.')
	if (
		scope === 'mac' &&
		assets.some(
			(name) =>
				name.startsWith('latest-') &&
				name.endsWith('.yml') &&
				!name.endsWith('-mac.yml'),
		)
	) {
		throw new Error(
			'This feed already serves Windows or Linux. Choose all platforms to keep their update feeds available.',
		)
	}
}
function releaseNotes(sha, scope) {
	return `Source: https://github.com/kody-hq/kody/commit/${sha}\nPlatforms: ${scope}`
}
function assertDraft(draft, sha, scope, assetNames) {
	if (!draft.isDraft)
		throw new Error(
			'Version already published. Bump the desktop version first.',
		)
	if (draft.body !== releaseNotes(sha, scope))
		throw new Error(
			'Draft source or platforms differ. Use a new version or remove the stale draft before retrying.',
		)
	if (draft.assets.some((asset) => !assetNames.includes(asset.name)))
		throw new Error(
			'Draft contains assets outside this release plan. Remove the stale draft before retrying.',
		)
}
if (require.main === module) {
	const scope = process.env.RELEASE_PLATFORMS || 'mac'
	if (process.argv.includes('--check-draft')) {
		assertDraft(
			JSON.parse(readFileSync(0, 'utf8')),
			process.env.SOURCE_SHA,
			scope,
			releaseAssetNames(process.env.RELEASE_VERSION, scope),
		)
	} else if (process.argv.includes('--notes')) {
		process.stdout.write(releaseNotes(process.env.SOURCE_SHA, scope))
	} else if (process.argv.includes('--check-feed')) {
		const latest = JSON.parse(readFileSync(0, 'utf8'))
		assertFeedCoverage(
			scope,
			latest.assets.map((asset) => asset.name),
		)
	} else {
		const plan = releasePlan(scope, process.env)
		const include = pendingTargets({
			include: plan.matrix.include,
			version: process.env.RELEASE_VERSION,
			sha: process.env.SOURCE_SHA,
			scope,
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
	assertFeedCoverage,
	releaseNotes,
	assertDraft,
	targetAssetNames,
	releaseAssetNames,
	uploadedAssetNames,
	pendingTargets,
}
