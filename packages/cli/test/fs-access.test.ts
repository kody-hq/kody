import assert from 'node:assert/strict'
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	allowLocalPath,
	effectiveFs,
	readLocalPolicy,
	removeLocalPath,
	resolveHostPath,
} from '../src/execution-context/fs-access.js'
import { runExecutionContextCommand } from '../src/execution-context/commands.js'

function sandbox() {
	// .native expands Windows 8.3 names (RUNNER~1) like the code under test.
	const root = realpathSync.native(
		mkdtempSync(join(tmpdir(), 'kody-fs-access-')),
	)
	const dir = (name: string) => {
		const path = join(root, name)
		mkdirSync(path, { recursive: true })
		return path
	}
	return { root, dir }
}

test('a folder is mounted only when both the grant and the local policy allow it', async () => {
	const { dir } = sandbox()
	const desktop = dir('Desktop')
	const docs = dir('Documents')
	const effective = await effectiveFs(
		[
			{ path: desktop, mode: 'rw' },
			{ path: docs, mode: 'rw' },
		],
		[{ path: desktop, mode: 'rw' }],
	)
	assert.deepEqual(effective.mounts, [{ path: desktop, mode: 'rw' }])
	assert.deepEqual(effective.refused, [
		{
			path: docs,
			layer: 'local_policy',
			reason: "this machine's local policy does not allow it",
		},
	])
	assert.deepEqual(
		(await effectiveFs([], [{ path: desktop, mode: 'rw' }])).mounts,
		[],
	)
	assert.deepEqual(
		(await effectiveFs([{ path: desktop, mode: 'rw' }], [])).mounts,
		[],
	)
})

test('the narrower mode wins and the overlap is the more specific folder', async () => {
	const { dir } = sandbox()
	const home = dir('home')
	const desktop = dir('home/Desktop')
	assert.deepEqual(
		(
			await effectiveFs(
				[{ path: desktop, mode: 'rw' }],
				[{ path: home, mode: 'ro' }],
			)
		).mounts,
		[{ path: desktop, mode: 'ro' }],
	)
	assert.deepEqual(
		(
			await effectiveFs(
				[{ path: home, mode: 'ro' }],
				[{ path: desktop, mode: 'rw' }],
			)
		).mounts,
		[{ path: desktop, mode: 'ro' }],
	)
	assert.deepEqual(
		(
			await effectiveFs(
				[{ path: home, mode: 'rw' }],
				[{ path: home, mode: 'rw' }],
			)
		).mounts,
		[{ path: home, mode: 'rw' }],
	)
})

test('prefix tricks, .. segments, and symlinks cannot escape a mount', async () => {
	const { root, dir } = sandbox()
	const desktop = dir('Desktop')
	const evil = dir('Desktop-evil')
	const secret = dir('secret')
	writeFileSync(join(secret, 'key.txt'), 'nope')
	symlinkSync(secret, join(desktop, 'link'))
	symlinkSync(secret, join(root, 'granted-link'))
	const effective = await effectiveFs(
		[
			{ path: desktop, mode: 'rw' },
			{ path: join(root, 'granted-link'), mode: 'rw' },
			{ path: `${desktop}/../secret`, mode: 'rw' },
		],
		[{ path: desktop, mode: 'rw' }],
	)
	assert.deepEqual(effective.mounts, [{ path: desktop, mode: 'rw' }])
	assert.deepEqual(
		effective.refused.map((refusal) => refusal.layer),
		['local_policy', 'server_grant'],
	)
	await assert.rejects(
		resolveHostPath(effective, join(evil, 'a.txt'), 'write'),
		{
			code: 'EACCES',
			message: /outside this execution context's server grant/,
		},
	)
	await assert.rejects(
		resolveHostPath(effective, `${desktop}/../secret/key.txt`, 'read'),
		{ code: 'EACCES' },
	)
	await assert.rejects(
		resolveHostPath(effective, join(desktop, 'link', 'key.txt'), 'read'),
		{ code: 'EACCES' },
	)
	await assert.rejects(
		resolveHostPath(effective, join(root, 'granted-link', 'key.txt'), 'read'),
		{ code: 'EACCES', message: /local policy does not allow it/ },
	)
	symlinkSync(join(secret, 'planted.txt'), join(desktop, 'dangling'))
	await assert.rejects(
		resolveHostPath(effective, join(desktop, 'dangling'), 'write'),
		{ code: 'EACCES' },
	)
	assert.equal(
		await resolveHostPath(effective, join(desktop, 'new', 'a.txt'), 'write'),
		join(desktop, 'new', 'a.txt'),
	)
	await assert.rejects(resolveHostPath(effective, 'Desktop/a.txt', 'read'), {
		code: 'EINVAL',
	})
})

test('ro mounts refuse writes and mount roots cannot be removed', async () => {
	const { dir } = sandbox()
	const desktop = dir('Desktop')
	const ro = await effectiveFs(
		[{ path: desktop, mode: 'rw' }],
		[{ path: desktop, mode: 'ro' }],
	)
	await assert.rejects(resolveHostPath(ro, join(desktop, 'a.txt'), 'write'), {
		code: 'EROFS',
		message: /read-only/,
	})
	assert.equal(
		await resolveHostPath(ro, join(desktop, 'a.txt'), 'read'),
		join(desktop, 'a.txt'),
	)
	const rw = await effectiveFs(
		[{ path: desktop, mode: 'rw' }],
		[{ path: desktop, mode: 'rw' }],
	)
	await assert.rejects(
		resolveHostPath(rw, desktop, 'write', { followFinal: false }),
		{ code: 'EACCES', message: /root of a host folder mount/ },
	)
})

test('the local policy file is absent until allowed, stores canonical paths, and validates its shape', async () => {
	const { root, dir } = sandbox()
	const policyPath = join(root, 'config', 'execution-context-policy.json')
	assert.deepEqual(await readLocalPolicy(policyPath), { version: 1, fs: [] })
	const desktop = dir('Desktop')
	symlinkSync(desktop, join(root, 'desk'))
	await allowLocalPath({ path: join(root, 'desk'), mode: 'rw', policyPath })
	await allowLocalPath({ path: desktop, mode: 'ro', policyPath })
	assert.deepEqual(await readLocalPolicy(policyPath), {
		version: 1,
		fs: [{ path: desktop, mode: 'ro' }],
	})
	await assert.rejects(
		allowLocalPath({ path: `${desktop}/../x`, mode: 'ro', policyPath }),
		/"\." or "\.\."/,
	)
	await assert.rejects(
		allowLocalPath({ path: join(root, 'missing'), mode: 'ro', policyPath }),
		/does not exist/,
	)
	assert.equal(
		(await removeLocalPath({ path: desktop, policyPath })).removed,
		true,
	)
	assert.deepEqual(await readLocalPolicy(policyPath), { version: 1, fs: [] })
	writeFileSync(
		policyPath,
		'{"version":1,"fs":[{"path":"relative","mode":"rw"}]}',
	)
	await assert.rejects(readLocalPolicy(policyPath), /must look like/)
})

test('kody context policy show, allow, and remove edit the file under the CLI config dir', async () => {
	const { root, dir } = sandbox()
	const desktop = dir('Desktop')
	const previous = process.env.XDG_CONFIG_HOME
	const previousHome = process.env.HOME
	const previousAppData = process.env.APPDATA
	process.env.XDG_CONFIG_HOME = join(root, 'xdg')
	process.env.HOME = join(root, 'home')
	process.env.APPDATA = join(root, 'appdata')
	try {
		const run = async (positionals: Array<string>, values = {}) => {
			let text = ''
			const code = await runExecutionContextCommand({
				command: 'context',
				positionals: ['policy', ...positionals],
				values,
				apiUrl: 'https://api.kody.test',
				token: async () => 'unused',
				clientVersion: '0.0.0',
				write: (chunk) => {
					text += chunk
				},
			})
			assert.equal(code, 0)
			return text
		}
		assert.match(await run(['show']), /No host folders are allowed/)
		assert.match(
			await run(['allow', desktop], { mode: 'rw' }),
			/Allowed .*Desktop \(rw\)/,
		)
		const policyFile = join(
			root,
			'xdg',
			'kody',
			'execution-context-policy.json',
		)
		if (process.platform === 'linux') {
			assert.deepEqual(JSON.parse(readFileSync(policyFile, 'utf8')).fs, [
				{ path: desktop, mode: 'rw' },
			])
		}
		assert.deepEqual(JSON.parse(await run(['show'], { json: true })).fs, [
			{ path: desktop, mode: 'rw' },
		])
		await assert.rejects(
			run(['allow', desktop], { mode: 'write' }),
			/--mode must be ro/,
		)
		assert.match(await run(['remove', desktop]), /Removed/)
	} finally {
		for (const [key, value] of [
			['XDG_CONFIG_HOME', previous],
			['HOME', previousHome],
			['APPDATA', previousAppData],
		] as const) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
})
