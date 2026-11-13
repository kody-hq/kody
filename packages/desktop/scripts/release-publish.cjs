const { createHash } = require('node:crypto')
const {
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const {
	assertDraft,
	assertFeedCoverage,
	releaseAssetNames,
	releaseNotes,
	releasePlan,
	targetAssetNames,
	uploadedAssetNames,
} = require('./release-plan.cjs')
const {
	defaultRun,
	githubDelaysMs,
	isTransientFailure,
	runWithRetry,
	sleepSync,
} = require('./release-retry.cjs')

// Uploads only the assets the draft is missing, then publishes it as latest
// only when every expected asset and update feed is present and consistent.
// Any failure leaves the draft in place for a re-run to resume.

function defaultGh(args, { toFile } = {}) {
	const label = `gh ${args
		.filter((arg) => !arg.startsWith('-'))
		.slice(0, 2)
		.join(' ')}`
	if (!toFile)
		return runWithRetry('gh', args, {
			delaysMs: githubDelaysMs,
			echo: false,
			label,
		}).result.stdout
	return runWithRetry('gh', args, {
		delaysMs: githubDelaysMs,
		echo: false,
		label,
		run: (command, argv) => {
			const fd = openSync(toFile, 'w')
			try {
				return defaultRun(command, argv, {
					stdio: ['ignore', fd, 'pipe'],
				})
			} finally {
				closeSync(fd)
			}
		},
	}).result.stdout
}

function sha(algorithm, file) {
	return createHash(algorithm).update(readFileSync(file)).digest()
}

// electron-builder writes a fixed, flat latest*.yml layout; read only the
// fields the updater depends on so the publish job needs no npm install.
function parseFeed(text) {
	const version = text.match(/^version: ['"]?([^'"\s]+)['"]?$/m)?.[1]
	const path = text.match(/^path: ['"]?([^'"\s]+)['"]?$/m)?.[1]
	const files = [
		...text.matchAll(
			/^ {2}- url: ['"]?([^'"\s]+)['"]?\n {4}sha512: (\S+)\n {4}size: (\d+)$/gm,
		),
	].map(([, url, sha512, size]) => ({ url, sha512, size: Number(size) }))
	return { version, path, files }
}

function assertFeed(name, text, version, assets, sha512Of) {
	const feed = parseFeed(text)
	if (feed.version !== version)
		throw new Error(
			`${name} is for ${feed.version ?? 'no version'}, not ${version}`,
		)
	if (!feed.files.length) throw new Error(`${name} lists no update files`)
	if (!feed.files.some((file) => file.url === feed.path))
		throw new Error(`${name} path ${feed.path} is not one of its files`)
	for (const file of feed.files) {
		const asset = assets.find((candidate) => candidate.name === file.url)
		if (!asset) throw new Error(`${name} points at missing asset ${file.url}`)
		if (asset.size !== file.size)
			throw new Error(`${name} size for ${file.url} does not match the release`)
		if (sha512Of(asset) !== file.sha512)
			throw new Error(
				`${name} sha512 for ${file.url} does not match the release`,
			)
	}
}

function findSupersededDrafts(json, repo, version) {
	const published = version.split('.').map(Number)
	return json(['api', '--paginate', '--slurp', `repos/${repo}/releases`])
		.flat()
		.filter((release) => {
			const parts = release.tag_name.match(/^v(\d+)\.(\d+)\.(\d+)$/)
			if (!release.draft || !parts) return false
			const order = published
				.map((part, index) => Number(parts[index + 1]) - part)
				.find((part) => part !== 0)
			return order < 0
		})
}

function publishRelease({
	repo,
	version,
	sourceSha,
	scope,
	assetsDir,
	gh = defaultGh,
	log = (line) => process.stderr.write(`${line}\n`),
	sleep = sleepSync,
	workDir = mkdtempSync(join(tmpdir(), 'kody-release-')),
}) {
	if (!/^\d+\.\d+\.\d+$/.test(version ?? ''))
		throw new Error('Desktop releases must use a stable version.')
	const tag = `v${version}`
	const json = (args) => JSON.parse(gh(args))
	let latest = null
	try {
		latest = json(['api', `repos/${repo}/releases/latest`])
	} catch (error) {
		if (!/HTTP 404/.test(error.output ?? '')) throw error
	}
	if (latest) {
		assertFeedCoverage(
			scope,
			latest.assets.map((asset) => asset.name),
		)
		const published = latest.tag_name.match(/^v(\d+)\.(\d+)\.(\d+)$/)
		if (!published) throw new Error('Unexpected published desktop tag.')
		const next = version.split('.').map(Number)
		const order = next
			.map((part, index) => part - Number(published[index + 1]))
			.find((part) => part !== 0)
		if (!(order > 0))
			throw new Error('Bump the desktop version above the published release.')
	}
	const notes = releaseNotes(sourceSha, scope)
	const expected = releaseAssetNames(version, scope)
	const findDraft = () =>
		json(['api', '--paginate', '--slurp', `repos/${repo}/releases`])
			.flat()
			.find((release) => release.tag_name === tag)

	// Never replace a published version. Drafts may be resumed.
	let release = findDraft()
	for (let attempt = 0; !release; attempt++) {
		try {
			release = json([
				'api',
				'-X',
				'POST',
				`repos/${repo}/releases`,
				'-f',
				`tag_name=${tag}`,
				'-f',
				`name=Kody ${version}`,
				'-f',
				`body=${notes}`,
				'-F',
				'draft=true',
			])
		} catch (error) {
			// A dropped create may still have made the draft; look before retrying
			// so a retry cannot leave two drafts for one tag.
			if (!isTransientFailure(error.output) || attempt >= 3) throw error
			sleep(githubDelaysMs[attempt])
			release = findDraft()
		}
	}
	assertDraft(
		{ ...release, isDraft: release.draft },
		sourceSha,
		scope,
		expected,
	)

	const local = new Map(
		readdirSync(assetsDir).map((name) => [name, join(assetsDir, name)]),
	)
	for (const name of local.keys())
		if (!expected.includes(name))
			throw new Error(`Built asset ${name} is not part of this release plan.`)
	const digests = new Map(
		[...local].map(([name, file]) => [
			name,
			`sha256:${sha('sha256', file).toString('hex')}`,
		]),
	)
	for (const [name, file] of local) {
		const existing = release.assets.find((asset) => asset.name === name)
		if (
			existing?.state === 'uploaded' &&
			existing.size > 0 &&
			existing.digest === digests.get(name)
		) {
			log(`${name} is already on the draft.`)
			continue
		}
		log(`Uploading ${name}.`)
		gh(['release', 'upload', tag, file, '--clobber', '--repo', repo])
	}

	release = json(['api', `repos/${repo}/releases/${release.id}`])
	assertDraft(
		{ ...release, isDraft: release.draft },
		sourceSha,
		scope,
		expected,
	)
	const uploaded = uploadedAssetNames(release)
	const missing = releasePlan(scope, {})
		.matrix.include.map((target) => ({
			target,
			names: targetAssetNames(version, target).filter(
				(name) => !uploaded.includes(name),
			),
		}))
		.filter(({ names }) => names.length)
	if (missing.length)
		throw new Error(
			`Draft ${tag} is missing ${missing
				.map(
					({ target, names }) =>
						`${target.platform} ${target.arch} (${names.join(', ')})`,
				)
				.join('; ')}; it stays a draft until a re-run uploads them.`,
		)
	const assets = release.assets
	const sha512Of = (asset) => {
		const file = local.get(asset.name)
		if (file && digests.get(asset.name) === asset.digest)
			return sha('sha512', file).toString('base64')
		const copy = join(workDir, asset.name)
		gh(
			[
				'api',
				'-H',
				'Accept: application/octet-stream',
				`repos/${repo}/releases/assets/${asset.id}`,
			],
			{ toFile: copy },
		)
		const hash = sha('sha512', copy).toString('base64')
		rmSync(copy, { force: true })
		return hash
	}
	try {
		for (const name of expected.filter((name) =>
			/^latest.*\.yml$/.test(name),
		)) {
			const asset = assets.find((candidate) => candidate.name === name)
			const file = local.get(name)
			let text
			if (file && digests.get(name) === asset.digest)
				text = readFileSync(file, 'utf8')
			else {
				const copy = join(workDir, name)
				gh(
					[
						'api',
						'-H',
						'Accept: application/octet-stream',
						`repos/${repo}/releases/assets/${asset.id}`,
					],
					{ toFile: copy },
				)
				text = readFileSync(copy, 'utf8')
			}
			assertFeed(name, text, version, assets, sha512Of)
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true })
	}

	const notesFile = join(assetsDir, '..', 'release-notes.txt')
	writeFileSync(notesFile, notes)
	gh([
		'api',
		'-X',
		'PATCH',
		`repos/${repo}/releases/${release.id}`,
		'-F',
		'draft=false',
		'-f',
		'make_latest=true',
		'-F',
		`body=@${notesFile}`,
	])
	const now = json(['api', `repos/${repo}/releases/latest`])
	if (now.tag_name !== tag)
		throw new Error(`Published ${tag}, but latest is ${now.tag_name}.`)
	log(`Published ${tag} with ${expected.length} assets.`)
	// A draft below the published version can never publish, so drop it
	// instead of leaving an incomplete release behind.
	for (const draft of findSupersededDrafts(json, repo, version)) {
		log(`Deleting superseded draft ${draft.tag_name}.`)
		gh(['api', '-X', 'DELETE', `repos/${repo}/releases/${draft.id}`])
	}
	return { tag, assets: expected.length }
}

if (require.main === module) {
	try {
		publishRelease({
			repo: process.env.GH_REPO,
			version: process.env.RELEASE_VERSION,
			sourceSha: process.env.SOURCE_SHA,
			scope: process.env.RELEASE_PLATFORMS || 'mac',
			assetsDir: process.argv[2] ?? 'release-assets',
		})
	} catch (error) {
		console.log(`::error title=Desktop release not published::${error.message}`)
		process.exitCode = 1
	}
}

module.exports = { assertFeed, parseFeed, publishRelease }
