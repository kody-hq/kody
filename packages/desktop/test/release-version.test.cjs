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
