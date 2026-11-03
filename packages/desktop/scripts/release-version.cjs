const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const { assertFeedCoverage, releaseNotes } = require('./release-plan.cjs')

function stableVersion(value) {
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
		throw new Error(`Expected a stable desktop version, got ${value}`)
	const parts = value.split('.').map(Number)
	if (!parts.every(Number.isSafeInteger))
		throw new Error('Desktop version is too large')
	return parts
}

function planVersion({ current, latest, sha, platforms }) {
	const baseline = stableVersion(current)
	const assets = latest?.assets.map((asset) => asset.name) || []
	const scope =
		platforms ||
		(assets.some(
			(name) =>
				name.startsWith('latest-') &&
				name.endsWith('.yml') &&
				!name.endsWith('-mac.yml'),
		)
			? 'all'
			: 'mac')
	assertFeedCoverage(scope, assets)
	if (!latest) return { version: current, platforms: scope, release: true }
	if (!latest.tag_name.startsWith('v'))
		throw new Error('Unexpected published desktop tag')
	const published = stableVersion(latest.tag_name.slice(1))
	if (latest.body === releaseNotes(sha, scope))
		return {
			version: latest.tag_name.slice(1),
			platforms: scope,
			release: false,
		}
	const comparison =
		baseline
			.map((part, index) => part - published[index])
			.find((part) => part !== 0) || 0
	const next = [...published]
	next[2]++
	const version = comparison > 0 ? current : next.join('.')
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
