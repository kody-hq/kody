const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const { planVersion } = require('../scripts/release-version.cjs')
const { releaseNotes } = require('../scripts/release-plan.cjs')

function plan(overrides = {}) {
	return planVersion({
		current: '0.1.5',
		sha: 'b'.repeat(40),
		isAncestor: () => true,
		latest: {
			tag_name: 'v0.1.5',
			body: releaseNotes('a'.repeat(40), 'mac'),
			assets: [{ name: 'latest-arm64-mac.yml' }],
		},
		...overrides,
	})
}

test('versions advance past the public feed even when the source package stays unchanged', () => {
	assert.equal(plan().version, '0.1.6')
	assert.equal(
		plan({
			latest: {
				tag_name: 'v0.1.9',
				body: releaseNotes('a'.repeat(40), 'mac'),
				assets: [],
			},
		}).version,
		'0.1.10',
	)
	assert.equal(plan({ current: '0.2.0' }).version, '0.2.0')
	assert.equal(plan({ latest: null }).version, '0.1.5')
})

test('a published source is skipped on retry', () => {
	assert.equal(plan({ sha: 'a'.repeat(40) }).release, false)
	assert.equal(plan().release, true)
})

test('automatic scope preserves existing platform feeds and explicit mac cannot remove them', () => {
	const latest = {
		tag_name: 'v0.1.5',
		body: releaseNotes('a'.repeat(40), 'all'),
		assets: [{ name: 'latest-x64.yml' }],
	}
	assert.equal(plan({ latest }).platforms, 'all')
	assert.equal(plan().platforms, 'mac')
	assert.equal(plan({ platforms: 'all' }).platforms, 'all')
	assert.throws(
		() => plan({ latest, platforms: 'mac' }),
		/Choose all platforms/,
	)
})

test('malformed and prerelease versions fail before signing', () => {
	for (const current of ['0.1.5-beta.1', '01.2.3', 'bad'])
		assert.throws(() => plan({ current }), /stable desktop version/)
	for (const tag_name of ['v0.1.6-beta.1', '0.1.5', 'vbad'])
		assert.throws(() => plan({ latest: { tag_name, assets: [] } }))
})

test('each build applies the chosen version to both package and lockfile', () => {
	const directory = mkdtempSync(join(tmpdir(), 'desktop-release-version-'))
	try {
		mkdirSync(join(directory, 'packages/desktop'), { recursive: true })
		writeFileSync(
			join(directory, 'packages/desktop/package.json'),
			JSON.stringify({ name: '@kodycodes/desktop', version: '0.1.5' }),
		)
		writeFileSync(
			join(directory, 'package-lock.json'),
			JSON.stringify({
				packages: {
					'packages/desktop': {
						version: '0.1.5',
						dependencies: { example: '1' },
					},
				},
			}),
		)
		execFileSync(
			process.execPath,
			[require.resolve('../scripts/release-version.cjs'), '--apply', '0.1.6'],
			{ cwd: directory },
		)
		const pkg = JSON.parse(
			readFileSync(join(directory, 'packages/desktop/package.json')),
		)
		const lock = JSON.parse(readFileSync(join(directory, 'package-lock.json')))
		assert.equal(pkg.version, '0.1.6')
		assert.equal(lock.packages['packages/desktop'].version, '0.1.6')
		assert.deepEqual(lock.packages['packages/desktop'].dependencies, {
			example: '1',
		})
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

test('an obsolete queued run cannot publish older source under a newer version', () => {
	assert.equal(plan({ isAncestor: () => false }).release, false)
	assert.throws(
		() =>
			plan({
				isAncestor: () => {
					throw new Error('Missing history')
				},
			}),
		/Missing history/,
	)
	assert.throws(
		() =>
			plan({
				latest: { tag_name: 'v0.1.5', assets: [], body: 'No provenance' },
			}),
		/source commit/,
	)
})

test('matching drafts resume while drafts from another source reserve their versions', () => {
	const draft = {
		draft: true,
		tag_name: 'v0.1.6',
		body: releaseNotes('b'.repeat(40), 'mac'),
		assets: [{ name: 'Kody-0.1.6-mac-arm64.zip' }],
	}
	assert.equal(plan({ drafts: [draft] }).version, '0.1.6')
	assert.equal(
		plan({ drafts: [{ ...draft, body: releaseNotes('c'.repeat(40), 'mac') }] })
			.version,
		'0.1.7',
	)
	assert.equal(
		plan({ drafts: [{ ...draft, assets: [{ name: 'unexpected.exe' }] }] })
			.version,
		'0.1.7',
	)
	assert.equal(
		plan({ drafts: [{ ...draft, body: releaseNotes('b'.repeat(40), 'all') }] })
			.version,
		'0.1.7',
	)
	assert.equal(
		plan({
			drafts: [
				{ ...draft, tag_name: 'v0.1.8', assets: [] },
				{ ...draft, body: 'other source' },
			],
		}).version,
		'0.1.8',
	)
	assert.equal(
		plan({
			drafts: [draft, { ...draft, tag_name: 'v0.1.9', body: 'other source' }],
		}).version,
		'0.1.10',
	)
	assert.equal(
		plan({ latest: null, drafts: [{ ...draft, body: 'other source' }] })
			.version,
		'0.1.7',
	)
})

test('recorded platform coverage survives missing feed assets', () => {
	const latest = {
		tag_name: 'v0.1.5',
		body: releaseNotes('a'.repeat(40), 'all'),
		assets: [],
	}
	assert.equal(plan({ latest }).platforms, 'all')
	assert.throws(
		() => plan({ latest, platforms: 'mac' }),
		/Choose all platforms/,
	)
})

test('unrelated and prerelease drafts cannot block a stable release', () => {
	const drafts = ['v0.2.0-rc', 'unrelated', ''].map((tag_name) => ({
		draft: true,
		tag_name,
		assets: [],
	}))
	assert.equal(plan({ drafts }).version, '0.1.6')
})

test('published history sets the version floor even when latest points to an older release', () => {
	const releases = [
		{
			draft: false,
			tag_name: 'v0.1.6',
			body: releaseNotes('a'.repeat(40), 'all'),
			assets: [],
		},
		{ draft: false, prerelease: true, tag_name: 'v0.2.0-rc', assets: [] },
	]
	assert.equal(plan({ releases }).version, '0.1.7')
	assert.equal(plan({ releases }).platforms, 'all')
	assert.equal(plan({ latest: null, releases }).version, '0.1.7')
	assert.equal(plan({ releases, isAncestor: () => false }).release, false)
	assert.equal(
		plan({
			releases: [
				...releases,
				{ draft: false, prerelease: true, tag_name: 'v0.1.9', assets: [] },
			],
		}).version,
		'0.1.10',
	)
})
