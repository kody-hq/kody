const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const {
	assertFeedCoverage,
	releaseNotes,
	releasePlan,
	assertDraft,
} = require('./release-plan.cjs')

function stableVersion(value) {
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
		throw new Error(`Expected a stable desktop version, got ${value}`)
	const parts = value.split('.').map(Number)
	if (!parts.every(Number.isSafeInteger))
		throw new Error('Desktop version is too large')
	return parts
}

function isPublishedSourceAncestor(source, sha) {
	const result = spawnSync(
		'git',
		['merge-base', '--is-ancestor', source, sha],
		{
			encoding: 'utf8',
		},
	)
	if (result.status === 0) return true
	if (result.status === 1) return false
	throw new Error(`Could not compare desktop release sources: ${result.stderr}`)
}

function compareVersions(left, right) {
	return (
		stableVersion(left)
			.map((part, index) => part - stableVersion(right)[index])
			.find((part) => part !== 0) || 0
	)
}

function nextPatch(version) {
	const parts = stableVersion(version)
	parts[2]++
	return parts.join('.')
}

function versionFromTag(tag) {
	if (!tag.startsWith('v')) throw new Error('Unexpected desktop release tag')
	const version = tag.slice(1)
	stableVersion(version)
	return version
}

function stableTagVersion(tag) {
	try {
		return versionFromTag(tag)
	} catch {
		return null
	}
}

function releaseAssetNames(version, scope) {
	return releasePlan(scope, {}).matrix.include.flatMap(({ platform, arch }) => {
		const os = platform
		const suffix =
			platform === 'mac'
				? '-mac'
				: platform === 'linux'
					? `-linux${arch === 'x64' ? '' : `-${arch}`}`
					: ''
		const artifactArch =
			platform === 'linux' && arch === 'x64' ? 'x86_64' : arch
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
	})
}

function planVersion({
	current,
	latest,
	sha,
	platforms,
	drafts = [],
	releases = [],
	isAncestor = isPublishedSourceAncestor,
}) {
	stableVersion(current)
	if (latest) versionFromTag(latest.tag_name)
	for (const release of releases) {
		if (
			release.draft ||
			release.prerelease ||
			!stableTagVersion(release.tag_name)
		)
			continue
		if (
			!latest ||
			compareVersions(
				versionFromTag(release.tag_name),
				versionFromTag(latest.tag_name),
			) > 0
		)
			latest = release
	}
	const assets = latest?.assets.map((asset) => asset.name) || []
	const recordedPlatforms = latest?.body?.match(/\nPlatforms: (mac|all)$/)?.[1]
	const scope =
		platforms ||
		(recordedPlatforms === 'all' ||
		assets.some(
			(name) =>
				name.startsWith('latest-') &&
				name.endsWith('.yml') &&
				!name.endsWith('-mac.yml'),
		)
			? 'all'
			: 'mac')
	if (scope === 'mac' && recordedPlatforms === 'all')
		throw new Error(
			'Choose all platforms to preserve the recorded desktop release scope.',
		)
	assertFeedCoverage(scope, assets)
	let version = current
	if (latest) {
		const published = versionFromTag(latest.tag_name)
		const source = latest.body?.match(
			/^Source: https:\/\/github\.com\/kody-hq\/kody\/commit\/([a-f0-9]{40})\nPlatforms: (mac|all)$/,
		)?.[1]
		if (!source)
			throw new Error('Published desktop release has no valid source commit')
		if (latest.body === releaseNotes(sha, scope) || !isAncestor(source, sha))
			return {
				version: latest.tag_name.slice(1),
				platforms: scope,
				release: false,
			}
		version =
			compareVersions(current, published) > 0 ? current : nextPatch(published)
	}
	const reserved = [...drafts, ...releases]
		.filter((draft) => stableTagVersion(draft.tag_name))
		.map((draft) => ({ draft, version: versionFromTag(draft.tag_name) }))
		.sort((a, b) => compareVersions(a.version, b.version))
	for (const { draft, version: reservedVersion } of reserved) {
		if (compareVersions(reservedVersion, version) < 0) continue
		try {
			assertDraft(
				{ ...draft, isDraft: draft.draft },
				sha,
				scope,
				releaseAssetNames(reservedVersion, scope),
			)
			version = reservedVersion
		} catch {
			version = nextPatch(reservedVersion)
		}
	}
	stableVersion(version)
	return { version, platforms: scope, release: true }
}

function applyVersion(version) {
	stableVersion(version)
	const packagePath = 'packages/desktop/package.json'
	const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
	const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
	pkg.version = version
	lock.packages['packages/desktop'].version = version
	writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
	writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`)
}

if (require.main === module) {
	if (process.argv[2] === '--apply') applyVersion(process.argv[3])
	else {
		const plan = planVersion({
			current: require('../package.json').version,
			latest: JSON.parse(readFileSync(0, 'utf8')),
			releases:
				process.argv[2] === '--releases'
					? JSON.parse(readFileSync(process.argv[3], 'utf8')).flat()
					: [],
			sha: process.env.SOURCE_SHA,
			platforms: process.env.RELEASE_PLATFORMS,
		})
		appendFileSync(
			process.env.GITHUB_OUTPUT,
			Object.entries(plan)
				.map(([key, value]) => `${key}=${value}\n`)
				.join(''),
		)
	}
}
module.exports = { planVersion, applyVersion }
