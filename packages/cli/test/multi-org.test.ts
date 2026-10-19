import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	ensureOpenApiCredentials,
	refreshStoredCredentials,
} from '../src/auth.js'
import { runCli } from '../src/cli.js'
import { buildUsage } from '../src/help.js'
import { orgEnvVar, resolveOrgSlug } from '../src/org-resolve.js'
import {
	createFileBackend,
	deleteCredentials,
	listStoredOrgs,
	loadCredentialStore,
	loadCredentials,
	migrateV1ToMultiOrg,
	parseCredentialStore,
	promotePendingOrg,
	saveCredentials,
	setActiveOrg,
	type StoredCredentials,
} from '../src/store.js'

const mcpUrl = 'https://multi-org.test/mcp'

function sample(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
	return {
		version: 1,
		mcpUrl,
		resource: mcpUrl,
		authorizationServerUrl: 'https://multi-org.test',
		clientId: 'client-1',
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		tokenType: 'bearer',
		expiresAt: Date.now() + 120_000,
		scope: 'openid profile email',
		...overrides,
	}
}

function tempBackend() {
	return createFileBackend(
		join(mkdtempSync(join(tmpdir(), 'kody-multi-org-')), 'credentials.json'),
	)
}

test('resolveOrgSlug prefers --org over KODY_ORG', () => {
	assert.equal(
		resolveOrgSlug({ flag: 'Acme', env: { [orgEnvVar]: 'other' } }),
		'acme',
	)
	assert.equal(resolveOrgSlug({ env: { [orgEnvVar]: 'Beta' } }), 'beta')
	assert.equal(resolveOrgSlug({ env: {} }), undefined)
	assert.equal(resolveOrgSlug({ env: {}, activeOrg: 'Acme' }), 'acme')
	assert.equal(
		resolveOrgSlug({
			env: { [orgEnvVar]: 'Beta' },
			activeOrg: 'Acme',
		}),
		'beta',
	)
})

test('a locally expired device token keeps a server-slid expiry', async () => {
	const backend = tempBackend()
	const token = 'kody_at_slid'
	saveCredentials(
		sample({
			accessToken: token,
			org: 'acme',
			expiresAt: Date.now() - 5_000,
		}),
		backend,
	)
	const stored = loadCredentials(mcpUrl, backend, undefined, { org: 'acme' })
	assert.ok(stored)
	const future = new Date(Date.now() + 60_000).toISOString()
	const refreshed = await refreshStoredCredentials({
		credentials: stored,
		backend,
		apiUrl: 'https://api.kody.codes',
		fetchFn: (async (input: Parameters<typeof fetch>[0]) => {
			assert.match(String(input), /\/v1\/tokens\/current/)
			return new Response(JSON.stringify({ expires_at: future }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		}) as typeof fetch,
	})
	assert.equal(refreshed.accessToken, token)
	assert.ok((refreshed.expiresAt ?? 0) > Date.now())
})

test('Open API login exchanges an unexpired OAuth token for a device token', async () => {
	const backend = tempBackend()
	saveCredentials(
		sample({ accessToken: 'oauth-access', expiresAt: Date.now() + 60_000 }),
		backend,
	)
	await assert.rejects(
		() =>
			ensureOpenApiCredentials({
				mcpUrl,
				backend,
				apiUrl: 'https://api.kody.codes',
				fetchFn: (async () => {
					throw new Error('refresh-attempted')
				}) as typeof fetch,
			}),
		/refresh-attempted/,
	)
})

test('v1 credentials migrate silently into a multi-org store as pending or named', () => {
	const pending = migrateV1ToMultiOrg(sample())
	assert.equal(pending.version, 2)
	assert.equal(pending.activeOrg, null)
	assert.ok(pending.pending)
	assert.deepEqual(Object.keys(pending.orgs), [])

	const named = migrateV1ToMultiOrg(sample({ org: 'Acme' }))
	assert.equal(named.activeOrg, 'acme')
	assert.equal(named.orgs.acme?.accessToken, 'access-1')
	assert.equal(named.pending, undefined)
})

test('parseCredentialStore upgrades on-disk v1 JSON without a re-login', () => {
	const raw = JSON.stringify(sample())
	const store = parseCredentialStore(raw, mcpUrl)
	assert.equal(store.version, 2)
	assert.ok(store.pending)
	assert.equal(store.activeOrg, null)

	const backend = tempBackend()
	backend.set(raw)
	const loaded = loadCredentials(mcpUrl, backend)
	assert.equal(loaded?.accessToken, 'access-1')
	assert.equal(loaded?.org, undefined)
})

test('login save upserts one org and keeps the other', () => {
	const backend = tempBackend()
	saveCredentials(sample({ org: 'acme', accessToken: 'a1' }), backend)
	saveCredentials(sample({ org: 'beta', accessToken: 'b1' }), backend)
	saveCredentials(sample({ org: 'acme', accessToken: 'a2' }), backend)

	const store = loadCredentialStore(mcpUrl, backend)
	assert.equal(store?.activeOrg, 'acme')
	assert.equal(store?.orgs.acme?.accessToken, 'a2')
	assert.equal(store?.orgs.beta?.accessToken, 'b1')
	assert.equal(loadCredentials(mcpUrl, backend)?.accessToken, 'a2')
	assert.equal(
		loadCredentials(mcpUrl, backend, undefined, { org: 'beta' })?.accessToken,
		'b1',
	)
})

test('pending-only store serves --org without attaching an unverified slug', () => {
	const backend = tempBackend()
	saveCredentials(sample({ accessToken: 'pending-tok' }), backend)
	const withOrg = loadCredentials(mcpUrl, backend, undefined, { org: 'acme' })
	assert.equal(withOrg?.accessToken, 'pending-tok')
	assert.equal(withOrg?.org, undefined)
	saveCredentials(sample({ org: 'beta', accessToken: 'named' }), backend)
	assert.equal(
		loadCredentials(mcpUrl, backend, undefined, { org: 'acme' }),
		null,
	)
})

test('setActiveOrg switches the default org', () => {
	const backend = tempBackend()
	saveCredentials(sample({ org: 'acme' }), backend)
	saveCredentials(sample({ org: 'beta' }), backend)
	setActiveOrg(mcpUrl, 'beta', backend)
	assert.equal(loadCredentials(mcpUrl, backend)?.org, 'beta')
	assert.deepEqual(listStoredOrgs(mcpUrl, backend), [
		{ slug: 'acme', active: false },
		{ slug: 'beta', active: true },
	])
})

test('logout without --org removes only the active org', () => {
	const backend = tempBackend()
	saveCredentials(sample({ org: 'acme' }), backend)
	saveCredentials(sample({ org: 'beta' }), backend)
	setActiveOrg(mcpUrl, 'acme', backend)
	const result = deleteCredentials(mcpUrl, backend)
	assert.equal(result.deleted, true)
	assert.equal(result.remaining, 1)
	const store = loadCredentialStore(mcpUrl, backend)
	assert.equal(store?.orgs.acme, undefined)
	assert.equal(store?.activeOrg, 'beta')
})

test('logout --org removes one org and keeps the rest', () => {
	const backend = tempBackend()
	saveCredentials(sample({ org: 'acme' }), backend)
	saveCredentials(sample({ org: 'beta' }), backend)
	const result = deleteCredentials(mcpUrl, backend, undefined, { org: 'acme' })
	assert.equal(result.deleted, true)
	assert.equal(result.remaining, 1)
	assert.equal(loadCredentialStore(mcpUrl, backend)?.orgs.beta?.org, 'beta')
})

test('promotePendingOrg finishes silent migration', () => {
	const backend = tempBackend()
	saveCredentials(sample(), backend)
	assert.ok(loadCredentialStore(mcpUrl, backend)?.pending)
	promotePendingOrg(mcpUrl, 'kentcdodds', backend)
	const store = loadCredentialStore(mcpUrl, backend)
	assert.equal(store?.pending, undefined)
	assert.equal(store?.activeOrg, 'kentcdodds')
	assert.equal(store?.orgs.kentcdodds?.accessToken, 'access-1')
})

test('saveCredentials activate:false refreshes tokens without switching activeOrg', () => {
	const backend = tempBackend()
	saveCredentials(sample({ org: 'acme', accessToken: 'a1' }), backend)
	saveCredentials(sample({ org: 'beta', accessToken: 'b1' }), backend)
	setActiveOrg(mcpUrl, 'acme', backend)
	saveCredentials(
		sample({ org: 'beta', accessToken: 'b2', refreshToken: 'b2-r' }),
		backend,
		undefined,
		{ activate: false },
	)
	const store = loadCredentialStore(mcpUrl, backend)
	assert.equal(store?.activeOrg, 'acme')
	assert.equal(store?.orgs.beta?.accessToken, 'b2')
	assert.equal(store?.orgs.acme?.accessToken, 'a1')
})

test('promotePendingOrg does not overwrite a fresh named login or steal activeOrg', () => {
	const backend = tempBackend()
	saveCredentials(
		sample({ accessToken: 'legacy', refreshToken: 'legacy-r' }),
		backend,
	)
	assert.ok(loadCredentialStore(mcpUrl, backend)?.pending)
	saveCredentials(
		sample({ org: 'beta', accessToken: 'fresh-beta', refreshToken: 'fresh-r' }),
		backend,
	)
	const mid = loadCredentialStore(mcpUrl, backend)
	assert.equal(mid?.activeOrg, 'beta')
	assert.equal(mid?.orgs.beta?.accessToken, 'fresh-beta')
	assert.equal(mid?.pending?.accessToken, 'legacy')

	promotePendingOrg(mcpUrl, 'acme', backend)
	const afterOther = loadCredentialStore(mcpUrl, backend)
	assert.equal(afterOther?.pending, undefined)
	assert.equal(afterOther?.activeOrg, 'beta')
	assert.equal(afterOther?.orgs.beta?.accessToken, 'fresh-beta')
	assert.equal(afterOther?.orgs.acme?.accessToken, 'legacy')

	saveCredentials(
		sample({ accessToken: 'legacy-2', refreshToken: 'legacy-2-r' }),
		backend,
	)
	saveCredentials(
		sample({
			org: 'acme',
			accessToken: 'fresh-acme',
			refreshToken: 'fresh-acme-r',
		}),
		backend,
	)
	promotePendingOrg(mcpUrl, 'acme', backend)
	const afterSame = loadCredentialStore(mcpUrl, backend)
	assert.equal(afterSame?.pending, undefined)
	assert.equal(afterSame?.activeOrg, 'acme')
	assert.equal(afterSame?.orgs.acme?.accessToken, 'fresh-acme')
})

test('help lists logged-in orgs from the local store offline', () => {
	const backend = tempBackend()
	saveCredentials(sample({ org: 'acme' }), backend)
	saveCredentials(sample({ org: 'beta' }), backend)
	setActiveOrg(mcpUrl, 'beta', backend)
	const text = buildUsage({
		mcpUrl,
		backend,
	})
	assert.match(text, /Logged-in orgs:/)
	assert.match(text, /\* beta\s+\(active\)/)
	assert.match(text, /  acme/)
	assert.match(text, /kody org list/)
	assert.match(text, /KODY_ORG/)
})

test('help hints kody login when nobody is logged in', () => {
	const text = buildUsage({
		mcpUrl,
		backend: tempBackend(),
	})
	assert.match(text, /Not logged in\. Run `kody login`\./)
})

test('kody org list and org use work for agents', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'kody-org-cli-'))
	const previousXdg = process.env.XDG_CONFIG_HOME
	process.env.XDG_CONFIG_HOME = dir
	try {
		const { fileStorePath } = await import('../src/store.js')
		const backend = createFileBackend(fileStorePath(mcpUrl, dir))
		saveCredentials(sample({ org: 'acme', accessToken: 'a' }), backend)
		saveCredentials(sample({ org: 'beta', accessToken: 'b' }), backend)

		let stdout = ''
		const listCode = await runCli(
			['org', 'list', '--mcp-url', mcpUrl, '--json'],
			{
				stdout: (text) => {
					stdout += text
				},
			},
		)
		assert.equal(listCode, 0, stdout)
		const parsed = JSON.parse(stdout) as {
			orgs: Array<{ slug: string; active: boolean }>
		}
		assert.deepEqual(parsed.orgs.map((row) => row.slug).sort(), [
			'acme',
			'beta',
		])

		stdout = ''
		const useCode = await runCli(['org', 'use', 'acme', '--mcp-url', mcpUrl], {
			stdout: (text) => {
				stdout += text
			},
		})
		assert.equal(useCode, 0, stdout)
		assert.match(stdout, /Active org is now acme/)
		assert.equal(loadCredentials(mcpUrl, backend)?.org, 'acme')
	} finally {
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdg
	}
})

test('kody org use without a slug errors without a TTY', async () => {
	let stderr = ''
	const code = await runCli(['org', 'use'], {
		stderr: (text) => {
			stderr += text
		},
	})
	assert.equal(code, 1)
	assert.match(
		stderr,
		/requires a TTY|No named org logins|Not logged in|Usage: kody org/,
	)
})

test('parseCredentials still derives a missing authorizationServerUrl (SEP-2352)', async () => {
	const { parseCredentials } = await import('../src/store.js')
	const parsed = parseCredentials(
		JSON.stringify({
			version: 1,
			mcpUrl: 'https://kody.codes/mcp',
			resource: 'https://kody.codes/mcp',
			clientId: 'client-1',
			accessToken: 'access',
			tokenType: 'bearer',
		}),
	)
	assert.equal(parsed.authorizationServerUrl, 'https://kody.codes')
})
