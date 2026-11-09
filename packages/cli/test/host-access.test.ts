import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runExecutionContextCommand } from '../src/execution-context/commands.js'
import { hostAccessNotes } from '../src/execution-context/host-access.js'
import { contextDir } from '../src/execution-context/keystore.js'

const apiUrl = 'https://api.kody.test'

// Absolute on this platform: grant paths are host paths.
const p = (path: string) =>
	process.platform === 'win32' ? `C:${path.replaceAll('/', '\\')}` : path
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function context(
	hostAccess?: {
		fs: Array<{ path: string; mode: 'ro' | 'rw' }>
		egress: { mode: string }
	},
	fs = hostAccess?.fs.length ?? 0,
) {
	return {
		id: 'ec_box',
		name: 'box',
		ownerOrg: { slug: 'acme' },
		grantSummary: { fs, egress: { mode: hostAccess?.egress.mode ?? 'public' } },
		...(hostAccess ? { hostAccess } : {}),
	}
}

async function withHome<T>(run: (home: string) => Promise<T>) {
	const home = mkdtempSync(join(tmpdir(), 'kody-host-access-'))
	const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME }
	process.env.HOME = home
	process.env.XDG_CONFIG_HOME = home
	try {
		return await run(home)
	} finally {
		if (saved.HOME === undefined) delete process.env.HOME
		else process.env.HOME = saved.HOME
		if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = saved.XDG
	}
}

function fakeApi(initial: ReturnType<typeof context>) {
	let current = initial
	const calls: Array<{ method: string; path: string; body?: unknown }> = []
	const fetchFn = (async (url: URL | string, init?: RequestInit) => {
		const path = new URL(url).pathname
		const method = init?.method ?? 'GET'
		const body = init?.body ? JSON.parse(String(init.body)) : undefined
		calls.push({ method, path, ...(body ? { body } : {}) })
		if (path === '/v1/execution-contexts') {
			return Response.json({
				contexts: [{ ...current, status: 'online', usable: true }],
			})
		}
		if (method === 'PATCH') {
			const grant = body.grant
			current = context({
				fs: grant.fs ?? current.hostAccess!.fs,
				egress: grant.egress ?? current.hostAccess!.egress,
			})
		}
		return Response.json({ context: current })
	}) as typeof fetch
	return { calls, fetchFn }
}

async function run(
	positionals: Array<string>,
	values: Record<string, string> = {},
	fetchFn?: typeof fetch,
) {
	let text = ''
	await runExecutionContextCommand({
		command: 'context',
		positionals,
		values,
		apiUrl,
		token: async () => 'kody_at_test',
		clientVersion: '0.0.0',
		write: (chunk) => {
			text += chunk
		},
		...(fetchFn ? { fetchFn } : {}),
	})
	return text
}

test('host access notes name the layer that is off in both directions', () => {
	assert.deepEqual(
		hostAccessNotes(context({ fs: [], egress: { mode: 'public' } }), [
			{ path: p('/home/me/project'), mode: 'rw' },
		]),
		[
			`${p('/home/me/project')} (local policy rw) is not in box's server grant, so runs cannot use it. Turn it on with: kody context grant allow ${p('/home/me/project')} --mode rw --context box`,
		],
	)
	assert.deepEqual(
		hostAccessNotes(
			context({
				fs: [{ path: p('/srv/data'), mode: 'ro' }],
				egress: { mode: 'public' },
			}),
			[],
		),
		[
			`${p('/srv/data')} (server grant ro) is not allowed by this machine's local policy, so runs cannot use it. The machine owner can allow it with: kody context policy allow ${p('/srv/data')} --mode ro`,
		],
	)
	assert.deepEqual(
		hostAccessNotes(
			context({
				fs: [{ path: p('/home/me'), mode: 'rw' }],
				egress: { mode: 'public' },
			}),
			[{ path: p('/home/me/project'), mode: 'rw' }],
		),
		[],
	)
	// Without write access the server sends only the folder count.
	assert.match(
		hostAccessNotes(context(undefined, 0), [{ path: '/a', mode: 'ro' }])[0]!,
		/server grant lists none \(grant\.fs: 0\)/,
	)
})

test('kody context grant allow adds one folder through PATCH and keeps the others', async () => {
	const api = fakeApi(
		context({
			fs: [{ path: p('/srv/data'), mode: 'ro' }],
			egress: { mode: 'public' },
		}),
	)
	const text = await withHome(() =>
		run(
			['grant', 'allow', p('/home/me/project')],
			{ context: 'box', mode: 'rw' },
			api.fetchFn,
		),
	)
	assert.deepEqual(
		api.calls.map((call) => `${call.method} ${call.path}`),
		[
			'GET /v1/execution-contexts',
			'GET /v1/execution-contexts/ec_box',
			'PATCH /v1/execution-contexts/ec_box',
		],
	)
	assert.deepEqual(api.calls[2]!.body, {
		grant: {
			fs: [
				{ path: p('/home/me/project'), mode: 'rw' },
				{ path: p('/srv/data'), mode: 'ro' },
			],
		},
	})
	assert.match(
		text,
		new RegExp(
			`^Added ${escape(p('/home/me/project'))} \\(rw\\) to box's server grant\\.`,
		),
	)
	assert.match(text, new RegExp(`rw {2}${escape(p('/home/me/project'))}`))
})

test('kody context grant lan on switches public egress and refuses an allowlist', async () => {
	const api = fakeApi(context({ fs: [], egress: { mode: 'public' } }))
	const text = await withHome(() =>
		run(['grant', 'lan', 'on'], { context: 'ec_box' }, api.fetchFn),
	)
	assert.deepEqual(api.calls.at(-1)!.body, {
		grant: { egress: { mode: 'public-and-lan' } },
	})
	assert.match(text, /Turned the local network on in box's server grant/)
	const allowlist = fakeApi(context({ fs: [], egress: { mode: 'allowlist' } }))
	await withHome(() =>
		assert.rejects(
			run(['grant', 'lan', 'on'], { context: 'ec_box' }, allowlist.fetchFn),
			/egress is allowlist, not public/,
		),
	)
	assert.equal(
		allowlist.calls.some((call) => call.method === 'PATCH'),
		false,
	)
})

test('kody context grant never patches when the server withholds write access', async () => {
	const api = fakeApi(context(undefined, 0))
	await withHome(() =>
		assert.rejects(
			run(
				['grant', 'allow', p('/home/me/project')],
				{ context: 'ec_box' },
				api.fetchFn,
			),
			/needs Contribute or Manage on it \(the same check as executionContextUpdate\)/,
		),
	)
	assert.equal(
		api.calls.some((call) => call.method === 'PATCH'),
		false,
	)
	await assert.rejects(
		run(['grant', 'lan', 'maybe']),
		/Usage: kody context grant/,
	)
})

test('kody context policy allow stays local and says when the server grant is off', async () => {
	await withHome(async (home) => {
		mkdirSync(contextDir(apiUrl, 'ec_box'), { recursive: true })
		const folder = join(home, 'project')
		mkdirSync(folder)
		const api = fakeApi(context({ fs: [], egress: { mode: 'public' } }))
		const text = await run(
			['policy', 'allow', folder],
			{ mode: 'rw' },
			api.fetchFn,
		)
		assert.equal(
			api.calls.some((call) => call.method !== 'GET'),
			false,
		)
		assert.match(text, /This does not change the context's server grant\./)
		assert.ok(
			text.includes(
				`is not in box's server grant, so runs cannot use it. Turn it on with: kody context grant allow `,
			),
			text,
		)
		const list = await run(['list'], {}, api.fetchFn)
		assert.match(list, /server grant: 0 host folders, LAN off \(this machine\)/)
		assert.match(list, /local policy rw\) is not in box's server grant/)
	})
})
