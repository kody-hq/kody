const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const {
	releaseAssetNames,
	releaseNotes,
} = require('../scripts/release-plan.cjs')
const { publishRelease } = require('../scripts/release-publish.cjs')

const repo = 'kody-hq/kody-desktop'
const version = '0.1.41'
const sourceSha = 'c'.repeat(40)
const notes = releaseNotes(sourceSha, 'mac')

function feed(arch, files) {
	return [
		`version: ${version}`,
		'files:',
		...files.flatMap(([name, body]) => [
			`  - url: ${name}`,
			`    sha512: ${createHash('sha512').update(body).digest('base64')}`,
			`    size: ${Buffer.byteLength(body)}`,
		]),
		`path: Kody-${version}-mac-${arch}.zip`,
		"releaseDate: '2026-11-08T00:00:00.000Z'",
		'',
	].join('\n')
}

// Builds a full set of fake Mac release files; no secrets or network.
function buildAssets() {
	const contents = new Map()
	for (const name of releaseAssetNames(version, 'mac'))
		if (!name.endsWith('.yml')) contents.set(name, `bytes of ${name}`)
	for (const arch of ['arm64', 'x64'])
		contents.set(
			`latest-${arch}-mac.yml`,
			feed(
				arch,
				['zip', 'dmg'].map((ext) => {
					const name = `Kody-${version}-mac-${arch}.${ext}`
					return [name, contents.get(name)]
				}),
			),
		)
	return contents
}

function writeAssets(contents, names = [...contents.keys()]) {
	const root = mkdtempSync(join(tmpdir(), 'kody-publish-test-'))
	const dir = join(root, 'release-assets')
	mkdirSync(dir)
	for (const name of names) writeFileSync(join(dir, name), contents.get(name))
	return dir
}

function fakeGitHub({ contents, draftAssets = [], latest = null }) {
	const state = { release: null, uploads: [], published: false, calls: [] }
	let nextId = 1
	const asset = (name) => ({
		id: nextId++,
		name,
		size: Buffer.byteLength(contents.get(name)),
		state: 'uploaded',
		digest: `sha256:${createHash('sha256').update(contents.get(name)).digest('hex')}`,
	})
	if (draftAssets.length)
		state.release = {
			id: 7,
			tag_name: `v${version}`,
			draft: true,
			body: notes,
			assets: draftAssets.map(asset),
		}
	const gh = (args, { toFile } = {}) => {
		state.calls.push(args.join(' '))
		const path = args.find((arg) => arg.startsWith('repos/'))
		if (args[0] === 'release' && args[1] === 'upload') {
			const name = args[3].split('/').pop()
			state.uploads.push(name)
			state.release.assets = state.release.assets.filter((a) => a.name !== name)
			state.release.assets.push(asset(name))
			return ''
		}
		if (path === `repos/${repo}/releases/latest`) {
			if (state.published) return JSON.stringify(state.release)
			if (!latest) {
				const error = new Error('gh api failed')
				error.output = 'gh: Not Found (HTTP 404)'
				throw error
			}
			return JSON.stringify(latest)
		}
		if (path === `repos/${repo}/releases` && args.includes('POST')) {
			state.release = {
				id: 7,
				tag_name: `v${version}`,
				draft: true,
				body: notes,
				assets: [],
			}
			return JSON.stringify(state.release)
		}
		if (path === `repos/${repo}/releases`)
			return JSON.stringify([state.release ? [state.release] : []])
		if (path === `repos/${repo}/releases/7` && args.includes('PATCH')) {
			state.published = true
			state.release.draft = false
			return JSON.stringify(state.release)
		}
		if (path === `repos/${repo}/releases/7`)
			return JSON.stringify(state.release)
		const download = path?.match(/releases\/assets\/(\d+)$/)
		if (download) {
			const found = state.release.assets.find(
				(a) => a.id === Number(download[1]),
			)
			writeFileSync(toFile, contents.get(found.name))
			return ''
		}
		throw new Error(`unexpected gh ${args.join(' ')}`)
	}
	return { gh, state }
}

const run = (assetsDir, gh) =>
	publishRelease({
		repo,
		version,
		sourceSha,
		scope: 'mac',
		assetsDir,
		gh,
		log: () => {},
		sleep: () => {},
	})

test('publishes a complete release as latest', () => {
	const contents = buildAssets()
	const github = fakeGitHub({ contents })
	run(writeAssets(contents), github.gh)
	assert.equal(github.state.published, true)
	assert.equal(github.state.uploads.length, contents.size)
})

test('a failed target leaves a draft and never publishes', () => {
	const contents = buildAssets()
	const github = fakeGitHub({ contents })
	const armOnly = [...contents.keys()].filter((name) => /arm64/.test(name))
	assert.throws(
		() => run(writeAssets(contents, armOnly), github.gh),
		/stays a draft/,
	)
	assert.equal(github.state.published, false)
	assert.equal(github.state.release.draft, true)
	assert.ok(!github.state.calls.some((call) => call.includes('PATCH')))
})

test('a resumed draft uploads only what is missing and checks remote feeds', () => {
	const contents = buildAssets()
	const armNames = [...contents.keys()].filter((name) => /arm64/.test(name))
	const x64Names = [...contents.keys()].filter((name) => !/arm64/.test(name))
	const github = fakeGitHub({ contents, draftAssets: armNames })
	run(writeAssets(contents, x64Names), github.gh)
	assert.deepEqual(github.state.uploads.sort(), x64Names.sort())
	assert.equal(github.state.published, true)
	assert.ok(
		github.state.calls.some((call) => /releases\/assets\/\d+$/.test(call)),
	)
})

test('a re-run with every asset already on the draft re-uploads nothing', () => {
	const contents = buildAssets()
	const github = fakeGitHub({ contents, draftAssets: [...contents.keys()] })
	run(writeAssets(contents), github.gh)
	assert.deepEqual(github.state.uploads, [])
	assert.equal(github.state.published, true)
})

test('a feed whose hash does not match its installer blocks publication', () => {
	const contents = buildAssets()
	contents.set(
		'latest-x64-mac.yml',
		contents.get('latest-x64-mac.yml').replace(/sha512: \S+/, 'sha512: wrong'),
	)
	const github = fakeGitHub({ contents })
	assert.throws(
		() => run(writeAssets(contents), github.gh),
		/sha512 for Kody-0\.1\.41-mac-x64\.zip/,
	)
	assert.equal(github.state.published, false)
})

test('a published version is never replaced', () => {
	const contents = buildAssets()
	const github = fakeGitHub({ contents, draftAssets: [...contents.keys()] })
	github.state.release.draft = false
	assert.throws(
		() => run(writeAssets(contents), github.gh),
		/already published/,
	)
	assert.deepEqual(github.state.uploads, [])
})

test('an unexpected built file is rejected before upload', () => {
	const contents = buildAssets()
	contents.set('Kody-0.1.41-mac-arm64.pkg', 'stray')
	const github = fakeGitHub({ contents })
	assert.throws(
		() => run(writeAssets(contents), github.gh),
		/not part of this release plan/,
	)
	assert.deepEqual(github.state.uploads, [])
})
