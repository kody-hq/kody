import { DatabaseSync } from 'node:sqlite'
import { ecpDefaultGrant } from '@kody-internal/shared/execution-context-protocol/index.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import {
	buildPublishedCredentialUseKvKey,
	buildPublishedSourceSnapshotKvKey,
	writePublishedSourceSnapshot,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import { routeExecute } from './routing.ts'
import {
	packageFilesUseCredentials,
	resetRunCredentialUseCacheForTest,
	resolveRunCredentialUse,
} from './run-credential-use.ts'

const usable = vi.hoisted(() => ({
	list: [] as Array<{
		id: string
		name: string
		scope: 'org' | 'personal'
		packageId: string | null
		expired: boolean
	}>,
}))

vi.mock('#worker/credentials/credential-candidates.ts', async (original) => ({
	...(await original<object>()),
	listUsableCredentials: async () => usable.list,
	listUsableCredentialsByPackage: async (input: {
		packageIds: Array<string>
	}) => new Map(input.packageIds.map((id) => [id, usable.list])),
}))

// Built at runtime so no literal placeholder sits in the source.
const secretPlaceholder = (name: string) =>
	`${'{'.repeat(2)}secret:${name}${'}'.repeat(2)}`

const orgId = 'org_acme'
const operator = 'user_operator'
const now = '2026-10-30T00:00:00.000Z'

type Setup = ReturnType<typeof setup>

function setup() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const { kv } = createMemoryKvNamespace()
	const dispatched: Array<unknown> = []
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		BUNDLE_ARTIFACTS_KV: kv,
		EXECUTION_CONTEXT_SESSION: {
			idFromName: (name: string) => name,
			get: () => ({
				dispatch: async (input: unknown) => {
					dispatched.push(input)
					return { outcome: 'committed' }
				},
				awaitResult: async () => ({
					result: {
						isError: false,
						content: [],
						structuredContent: { ranOnContext: true },
					},
				}),
				cancel: async () => {},
			}),
		},
	} as unknown as Env
	return { sqlite, kv, env, dispatched }
}

async function publishPackage(
	s: Setup,
	input: { id: string; name: string; files: Record<string, string> },
) {
	const sourceId = `src_${input.id}`
	s.sqlite
		.prepare(
			`INSERT INTO entity_sources (id, user_id, entity_kind, entity_id, repo_id,
				published_commit, manifest_path, source_root, created_at, updated_at)
			 VALUES (?, ?, 'package', ?, ?, 'commit-1', 'package.json', '/', ?, ?)`,
		)
		.run(sourceId, orgId, input.id, `repo_${input.id}`, now, now)
	s.sqlite
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description,
				source_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'fixture', ?, ?, ?)`,
		)
		.run(input.id, orgId, input.name, input.id, sourceId, now, now)
	await s.kv.put(
		buildPublishedSourceSnapshotKvKey({
			sourceId,
			publishedCommit: 'commit-1',
		}),
		JSON.stringify({
			version: 1,
			sourceId,
			repoId: `repo_${input.id}`,
			entityKind: 'package',
			entityId: input.id,
			publishedCommit: 'commit-1',
			manifestPath: 'package.json',
			sourceRoot: '/',
			files: {
				'package.json': JSON.stringify({
					name: input.name,
					exports: { './run': './run.ts' },
					kody: { id: input.id, description: 'fixture' },
				}),
				...input.files,
			},
			createdAt: now,
		}),
	)
}

function addContext(
	s: Setup,
	input: { id: string; credentials: (typeof ecpDefaultGrant)['credentials'] },
) {
	s.sqlite
		.prepare(
			`INSERT INTO execution_contexts (id, org_id, operator_user_id, all_members, name,
				public_key_jwk, thumbprint, created_at, grant_json, grant_version)
			 VALUES (?, ?, ?, 0, ?, '{}', ?, ?, ?, 1)`,
		)
		.run(
			input.id,
			orgId,
			operator,
			`mac-${input.id}`,
			`thumb_${input.id}`,
			now,
			JSON.stringify({ ...ecpDefaultGrant, credentials: input.credentials }),
		)
	s.sqlite
		.prepare(
			`INSERT INTO execution_context_chains (org_id, user_id, strict, version, updated_at, updated_by_kind)
			 VALUES (?, ?, 0, 1, ?, 'user')`,
		)
		.run(orgId, operator, now)
	s.sqlite
		.prepare(
			`INSERT INTO execution_context_chain_entries (org_id, user_id, position, context_id)
			 VALUES (?, ?, 0, ?), (?, ?, 1, NULL)`,
		)
		.run(orgId, operator, input.id, orgId, operator)
}

const requestContext = {} as RequestContext

function route(s: Setup, code: string) {
	return routeExecute({
		env: s.env,
		request: {
			userId: operator,
			handle: 'operator',
			orgId,
			orgSlug: 'acme',
			scopes: null,
			credentialKind: 'oauth',
		},
		args: {},
		runId: 'run_1',
		runRecord: null,
		code,
		params: {},
		credentials: null,
		credentialUse: () =>
			resolveRunCredentialUse({
				env: s.env,
				request: requestContext,
				ownerId: orgId,
				code,
				credentials: null,
			}),
		apiUrl: 'https://api.kody.test',
		waitMs: 5_000,
	})
}

const wakeFiles = {
	'run.ts': `export default async () => fetch('https://api.example.com/wake', { headers: { authorization: 'Bearer ${secretPlaceholder('botKey')}' } })\n`,
}
const plainFiles = { 'run.ts': 'export default async () => ({ ok: true })\n' }
const importWake =
	"import wake from 'kody:@acme/wake/run'\nexport default async (p) => wake(p)\n"

beforeEach(() => {
	usable.list = []
	resetRunCredentialUseCacheForTest()
})

test('a context that allows no credentials is skipped for a run whose imported package uses one, and the run falls through to cloud', async () => {
	const s = setup()
	await publishPackage(s, {
		id: 'pkg_wake',
		name: '@acme/wake',
		files: wakeFiles,
	})
	addContext(s, { id: 'ec_mac', credentials: { mode: 'none' } })
	const outcome = await route(s, importWake)
	expect(outcome.kind).toBe('cloud')
	expect(s.dispatched).toHaveLength(0)
	expect(outcome.kind === 'cloud' && outcome.metadata).toMatchObject({
		fellBackToCloud: true,
		attempts: [
			{
				target: 'ec_mac',
				outcome: 'skipped',
				reason: 'credentials_not_allowed',
			},
		],
	})
})

test('credential use is found through a package that only imports one that uses credentials', async () => {
	const s = setup()
	await publishPackage(s, {
		id: 'pkg_wake',
		name: '@acme/wake',
		files: wakeFiles,
	})
	await publishPackage(s, {
		id: 'pkg_outer',
		name: '@acme/outer',
		files: {
			'run.ts':
				"import wake from 'kody:@acme/wake/run'\nexport default async () => wake()\n",
		},
	})
	addContext(s, { id: 'ec_mac', credentials: { mode: 'none' } })
	const outcome = await route(
		s,
		"import outer from 'kody:@acme/outer/run'\nexport default async () => outer()\n",
	)
	expect(outcome.kind).toBe('cloud')
	expect(s.dispatched).toHaveLength(0)
})

test('a run that uses no credentials still runs on a context that allows none', async () => {
	const s = setup()
	await publishPackage(s, {
		id: 'pkg_plain',
		name: '@acme/plain',
		files: plainFiles,
	})
	addContext(s, { id: 'ec_mac', credentials: { mode: 'none' } })
	const outcome = await route(
		s,
		"import plain from 'kody:@acme/plain/run'\nexport default async () => plain()\n",
	)
	expect(outcome.kind).toBe('ran')
	expect(s.dispatched).toHaveLength(1)
})

test('a requester grant on an unshared context takes a credentialed run', async () => {
	const s = setup()
	await publishPackage(s, {
		id: 'pkg_wake',
		name: '@acme/wake',
		files: wakeFiles,
	})
	addContext(s, { id: 'ec_mac', credentials: { mode: 'requester' } })
	const outcome = await route(s, importWake)
	expect(outcome.kind).toBe('ran')
	expect(s.dispatched).toHaveLength(1)
})

test('a requester grant on a shared context is skipped for a credentialed run', async () => {
	const s = setup()
	await publishPackage(s, {
		id: 'pkg_wake',
		name: '@acme/wake',
		files: wakeFiles,
	})
	addContext(s, { id: 'ec_mac', credentials: { mode: 'requester' } })
	s.sqlite
		.prepare(
			`INSERT INTO execution_context_org_attachments (context_id, org_id, attached_by_user_id, all_members, created_at)
			 VALUES ('ec_mac', 'org_other', ?, 0, ?)`,
		)
		.run(operator, now)
	const outcome = await route(s, importWake)
	expect(outcome.kind === 'cloud' && outcome.metadata?.attempts).toMatchObject([
		{ outcome: 'skipped', reason: 'credentials_need_unshared_context' },
	])
})

test('a list grant takes a run whose named credentials it covers, and skips one it cannot verify', async () => {
	const s = setup()
	await publishPackage(s, {
		id: 'pkg_wake',
		name: '@acme/wake',
		files: wakeFiles,
	})
	addContext(s, {
		id: 'ec_mac',
		credentials: { mode: 'list', ids: ['cred_gh'] },
	})
	usable.list = [
		{
			id: 'cred_gh',
			name: 'github',
			scope: 'personal',
			packageId: null,
			expired: false,
		},
		{
			id: 'cred_x',
			name: 'xkey',
			scope: 'personal',
			packageId: null,
			expired: false,
		},
	]
	const named = (name: string) =>
		`export default async () => fetch('https://api.example.com', { headers: { authorization: '${secretPlaceholder(name)}' } })\n`
	expect((await route(s, named('github'))).kind).toBe('ran')
	const uncovered = await route(s, named('xkey'))
	expect(
		uncovered.kind === 'cloud' && uncovered.metadata?.attempts,
	).toMatchObject([{ reason: 'credentials_not_in_grant' }])
	const viaPackage = await route(s, importWake)
	expect(
		viaPackage.kind === 'cloud' && viaPackage.metadata?.attempts,
	).toMatchObject([{ reason: 'credentials_unverified' }])
})

test('a Key bound to an imported package counts as credential use', async () => {
	const s = setup()
	await publishPackage(s, {
		id: 'pkg_plain',
		name: '@acme/plain',
		files: plainFiles,
	})
	usable.list = [
		{
			id: 'cred_pkg',
			name: 'key',
			scope: 'org',
			packageId: 'pkg_plain',
			expired: false,
		},
	]
	expect(
		await resolveRunCredentialUse({
			env: s.env,
			request: requestContext,
			ownerId: orgId,
			code: "import plain from 'kody:@acme/plain/run'\nexport default () => plain()\n",
			credentials: null,
		}),
	).toEqual({ kind: 'unknown' })
})

test('an import that does not resolve counts as credential use', async () => {
	const s = setup()
	expect(
		await resolveRunCredentialUse({
			env: s.env,
			request: requestContext,
			ownerId: orgId,
			code: "import gone from 'kody:@acme/gone/run'\nexport default () => gone()\n",
			credentials: null,
		}),
	).toEqual({ kind: 'unknown' })
})

test('package files that call credentialed runtime APIs or declare credentials use credentials', () => {
	expect(packageFilesUseCredentials(plainFiles)).toBe(false)
	expect(packageFilesUseCredentials(wakeFiles)).toBe(true)
	expect(
		packageFilesUseCredentials({
			'run.ts':
				"import { kody } from 'kody:runtime'\nexport default () => kody.authenticatedFetch('https://api.example.com')\n",
		}),
	).toBe(true)
	expect(
		packageFilesUseCredentials({
			'run.ts':
				"import { kody } from 'kody:runtime'\nexport default () => kody.credentialClientFetch({})\n",
		}),
	).toBe(true)
	expect(
		packageFilesUseCredentials({
			'run.ts':
				"import * as rt from 'kody:runtime'\nexport default () => rt.kody.authenticatedFetch('https://api.example.com')\n",
		}),
	).toBe(true)
	expect(
		packageFilesUseCredentials({
			'package.json': JSON.stringify({
				name: '@acme/declared',
				kody: { credentials: { github: { description: 'GitHub' } } },
			}),
			...plainFiles,
		}),
	).toBe(true)
	expect(
		packageFilesUseCredentials({
			'run.ts':
				"import { kody } from 'kody:runtime'\nexport default () => kody.metaGetCurrentUser({})\n",
		}),
	).toBe(false)
})

const importPlain =
	"import plain from 'kody:@acme/plain/run'\nexport default () => plain()\n"

function resolvePlain(s: Setup) {
	return resolveRunCredentialUse({
		env: s.env,
		request: requestContext,
		ownerId: orgId,
		code: importPlain,
		credentials: null,
	})
}

test('a package whose snapshot cannot be read yet is not cached as using credentials', async () => {
	const s = setup()
	await publishPackage(s, {
		id: 'pkg_late',
		name: '@acme/plain',
		files: plainFiles,
	})
	const snapshotKey = buildPublishedSourceSnapshotKvKey({
		sourceId: 'src_pkg_late',
		publishedCommit: 'commit-1',
	})
	const snapshot = await s.kv.get(snapshotKey)
	await s.kv.delete(snapshotKey)
	expect(await resolvePlain(s)).toEqual({ kind: 'unknown' })
	expect(
		await s.kv.get(
			buildPublishedCredentialUseKvKey({
				sourceId: 'src_pkg_late',
				publishedCommit: 'commit-1',
			}),
		),
	).toBeNull()
	await s.kv.put(snapshotKey, snapshot as string)
	expect(await resolvePlain(s)).toEqual({ kind: 'none' })
})

test('a failed credential-use cache write does not change the answer', async () => {
	const s = setup()
	await publishPackage(s, {
		id: 'pkg_nowrite',
		name: '@acme/plain',
		files: plainFiles,
	})
	const put = s.kv.put.bind(s.kv)
	s.kv.put = (async (key: string, value: string) => {
		if (key.startsWith('credential-use:')) throw new Error('KV write failed')
		return await put(key, value)
	}) as typeof s.kv.put
	expect(await resolvePlain(s)).toEqual({ kind: 'none' })
})

test('a same-commit snapshot write clears the cached credential-use answer', async () => {
	const s = setup()
	const useKey = buildPublishedCredentialUseKvKey({
		sourceId: 'src_pkg_fix',
		publishedCommit: 'commit-1',
	})
	await s.kv.put(useKey, JSON.stringify({ version: 1, uses: false, deps: [] }))
	await writePublishedSourceSnapshot({
		env: s.env,
		source: {
			id: 'src_pkg_fix',
			repo_id: 'repo_pkg_fix',
			entity_kind: 'package',
			entity_id: 'pkg_fix',
			published_commit: 'commit-1',
			manifest_path: 'package.json',
			source_root: '/',
		} as never,
		files: { 'package.json': '{}', ...wakeFiles },
	})
	expect(await s.kv.get(useKey)).toBeNull()
})

test('credentialed reads through a kody:runtime namespace import count, unrelated members do not', () => {
	const uses = (source: string) =>
		packageFilesUseCredentials({ 'run.ts': source })
	const ns = "import * as rt from 'kody:runtime'\n"
	expect(uses(`${ns}export default (p) => rt.kody[p.method](p)\n`)).toBe(true)
	expect(
		uses(
			`${ns}const { authenticatedFetch } = rt.kody\nexport default () => authenticatedFetch('https://x.test')\n`,
		),
	).toBe(true)
	expect(
		uses(
			`${ns}const k = rt.kody\nexport default () => k.gatewayFetch('https://x.test')\n`,
		),
	).toBe(true)
	expect(
		uses(
			`${ns}export default (p, foo) => [rt.kody.metaGetCurrentUser({}), foo.authenticatedFetch, p.credentials]\n`,
		),
	).toBe(false)
})

test('kody:runtime aliases declared after the read that uses them still count', () => {
	const uses = (source: string) =>
		packageFilesUseCredentials({ 'run.ts': source })
	const ns = "import * as rt from 'kody:runtime'\n"
	expect(
		uses(
			`${ns}function run() { return k.gatewayFetch('https://x.test') }\nconst k = rt.kody\nexport default () => run()\n`,
		),
	).toBe(true)
	expect(
		uses(
			`${ns}function run() { const { authenticatedFetch } = k; return authenticatedFetch('https://x.test') }\nconst k = rt.kody\nexport default () => run()\n`,
		),
	).toBe(true)
	expect(
		uses(
			`${ns}function run() { return b.kody.gatewayFetch('https://x.test') }\nconst b = a\nconst a = rt\nexport default () => run()\n`,
		),
	).toBe(true)
	expect(
		uses(
			`${ns}function run() { return k.metaGetCurrentUser({}) }\nconst k = rt.kody\nexport default () => run()\n`,
		),
	).toBe(false)
})
