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
import { type EffectivePermissions } from '#worker/authorization/authorize.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
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
	const enqueued: Array<unknown> = []
	const outcomes = new Map<string, string>()
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		BUNDLE_ARTIFACTS_KV: kv,
		EXECUTION_CONTEXT_SESSION: {
			idFromName: (name: string) => name,
			get: (ecid: string) => ({
				dispatch: async (input: unknown) => {
					const outcome = outcomes.get(ecid) ?? 'committed'
					if (outcome === 'committed') dispatched.push(input)
					return { outcome }
				},
				enqueue: async (input: unknown) => {
					enqueued.push(input)
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
	return { sqlite, kv, env, dispatched, enqueued, outcomes }
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

const friend = 'user_friend'

function addContext(s: Setup, input: { id: string; allMembers?: boolean }) {
	s.sqlite
		.prepare(
			`INSERT INTO execution_contexts (id, org_id, operator_user_id, all_members, name,
				public_key_jwk, thumbprint, created_at, grant_json, grant_version)
			 VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, 1)`,
		)
		.run(
			input.id,
			orgId,
			operator,
			input.allMembers ? 1 : 0,
			`mac-${input.id}`,
			`thumb_${input.id}`,
			now,
			JSON.stringify(ecpDefaultGrant),
		)
}

/** A chain of the given contexts, then Kody cloud unless `strict`. */
function setChain(
	s: Setup,
	userId: string,
	contexts: Array<string>,
	options: { strict?: boolean } = {},
) {
	s.sqlite
		.prepare(
			`INSERT INTO execution_context_chains (org_id, user_id, strict, version, updated_at, updated_by_kind)
			 VALUES (?, ?, ?, 1, ?, 'user')`,
		)
		.run(orgId, userId, options.strict ? 1 : 0, now)
	const entries = options.strict ? contexts : [...contexts, null]
	entries.forEach((contextId, position) =>
		s.sqlite
			.prepare(
				`INSERT INTO execution_context_chain_entries (org_id, user_id, position, context_id)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(orgId, userId, position, contextId),
	)
}

/** Everyone in the org may use the context, and the friend opted in. */
function shareWithFriend(s: Setup, contextId: string) {
	s.sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.run(orgId, friend, now)
	s.sqlite
		.prepare(
			`INSERT INTO execution_context_opt_ins (context_id, user_id, org_id, created_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(contextId, friend, orgId, now)
}

const requestContext = {} as RequestContext

function route(
	s: Setup,
	code: string,
	options: {
		userId?: string
		args?: Parameters<typeof routeExecute>[0]['args']
		queue?: { expiresAt: number } | null
		profile?: { id: string; grantedContexts: Array<string> }
	} = {},
) {
	return routeExecute({
		env: s.env,
		request: {
			userId: options.userId ?? operator,
			handle: options.userId ?? 'operator',
			orgId,
			orgSlug: 'acme',
			scopes: null,
			credentialKind: 'oauth',
			...(options.profile
				? {
						profileId: options.profile.id,
						profileAccess: profileAccessFor(options.profile),
					}
				: {}),
		},
		args: options.args ?? {},
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
		queue: options.queue ?? null,
	})
}

/** Owner access narrowed by a one-layer profile granted only these contexts. */
function profileAccessFor(profile: {
	id: string
	grantedContexts: Array<string>
}): EffectivePermissions {
	const grants = new Map(
		profile.grantedContexts.map((id) => [
			`execution_context:${id}`,
			new Set<OrgPermission>(['execution_context:execute']),
		]),
	)
	return {
		orgId: orgId as OwnerId,
		permissions: new Set<OrgPermission>(['execution_context:execute']),
		isOwner: true,
		resourcePermissions: new Map(),
		credentialScopes: null,
		profileGrants: null,
		profileChain: {
			inactive: null,
			layers: [
				{
					id: profile.id,
					name: 'bot',
					self: true,
					orgPermissions: new Set(),
					resourcePermissions: grants,
				},
			],
		},
	}
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

test("the operator's credentialed run takes their own context, as it would cloud", async () => {
	const s = setup()
	await publishPackage(s, {
		id: 'pkg_wake',
		name: '@acme/wake',
		files: wakeFiles,
	})
	addContext(s, { id: 'ec_mac' })
	setChain(s, operator, ['ec_mac'])
	const outcome = await route(s, importWake)
	expect(outcome.kind).toBe('ran')
	expect(s.dispatched).toHaveLength(1)
})

test('credential use through a package that only imports one that uses credentials does not keep the operator off their context', async () => {
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
	addContext(s, { id: 'ec_mac' })
	setChain(s, operator, ['ec_mac'])
	expect(
		await resolveRunCredentialUse({
			env: s.env,
			request: requestContext,
			ownerId: orgId,
			code: "import outer from 'kody:@acme/outer/run'\nexport default () => outer()\n",
			credentials: null,
		}),
	).toEqual({ kind: 'unknown' })
	const outcome = await route(
		s,
		"import outer from 'kody:@acme/outer/run'\nexport default () => outer()\n",
	)
	expect(outcome.kind).toBe('ran')
})

test("someone else's run that uses no credentials runs on a shared context", async () => {
	const s = setup()
	addContext(s, { id: 'ec_mac', allMembers: true })
	shareWithFriend(s, 'ec_mac')
	setChain(s, friend, ['ec_mac'])
	const outcome = await route(s, 'export default () => 1\n', {
		userId: friend,
	})
	expect(outcome.kind).toBe('ran')
	expect(s.dispatched).toHaveLength(1)
})

test("someone else's credentialed run skips a shared context and falls through to cloud", async () => {
	const s = setup()
	await publishPackage(s, {
		id: 'pkg_wake',
		name: '@acme/wake',
		files: wakeFiles,
	})
	addContext(s, { id: 'ec_mac', allMembers: true })
	shareWithFriend(s, 'ec_mac')
	setChain(s, friend, ['ec_mac'])
	const outcome = await route(s, importWake, { userId: friend })
	expect(outcome.kind).toBe('cloud')
	expect(s.dispatched).toHaveLength(0)
	expect(outcome.kind === 'cloud' && outcome.metadata).toMatchObject({
		fellBackToCloud: true,
		attempts: [
			{
				target: 'ec_mac',
				outcome: 'skipped',
				reason: 'credentials_operator_only',
			},
		],
	})
})

test('a busy context falls through to the next context in the chain', async () => {
	const s = setup()
	addContext(s, { id: 'ec_busy' })
	addContext(s, { id: 'ec_free' })
	setChain(s, operator, ['ec_busy', 'ec_free'])
	s.outcomes.set('ec_busy', 'busy')
	const outcome = await route(s, 'export default () => 1\n')
	expect(outcome).toMatchObject({
		kind: 'ran',
		metadata: {
			id: 'ec_free',
			fellBackToCloud: false,
			attempts: [
				{ target: 'ec_busy', outcome: 'busy' },
				{ target: 'ec_free', outcome: 'ran' },
			],
		},
	})
})

test('a busy context falls back to cloud with the busy attempt recorded', async () => {
	const s = setup()
	addContext(s, { id: 'ec_mac' })
	setChain(s, operator, ['ec_mac'])
	s.outcomes.set('ec_mac', 'busy')
	const outcome = await route(s, 'export default () => 1\n')
	expect(outcome).toEqual({
		kind: 'cloud',
		metadata: expect.objectContaining({
			id: 'ec_mac',
			fellBackToCloud: true,
			attempts: [{ target: 'ec_mac', name: 'mac-ec_mac', outcome: 'busy' }],
		}),
	})
})

test('a named context that is busy fails and says it was busy, unless it may fall back to the chain', async () => {
	const s = setup()
	addContext(s, { id: 'ec_mac' })
	setChain(s, operator, ['ec_mac'])
	s.outcomes.set('ec_mac', 'busy')
	await expect(
		route(s, 'export default () => 1\n', { args: { context: 'mac-ec_mac' } }),
	).rejects.toThrow(/mac-ec_mac is busy: it is already running as many runs/)
	const outcome = await route(s, 'export default () => 1\n', {
		args: { context: 'mac-ec_mac', fallback: 'chain' },
	})
	expect(outcome.kind).toBe('cloud')
})

for (const unavailable of ['busy', 'offline'] as const) {
	test(`a queueing run on a ${unavailable} context still falls back to a later cloud entry`, async () => {
		const s = setup()
		addContext(s, { id: 'ec_mac' })
		setChain(s, operator, ['ec_mac'])
		s.outcomes.set('ec_mac', unavailable)
		const outcome = await route(s, 'export default () => 1\n', {
			queue: { expiresAt: Date.parse(now) + 60_000 },
		})
		expect(outcome.kind).toBe('cloud')
		expect(s.enqueued).toHaveLength(0)
	})

	test(`a queueing run queues on a ${unavailable} context when no later target can take it`, async () => {
		const s = setup()
		addContext(s, { id: 'ec_mac' })
		setChain(s, operator, ['ec_mac'], { strict: true })
		s.outcomes.set('ec_mac', unavailable)
		const outcome = await route(s, 'export default () => 1\n', {
			queue: { expiresAt: Date.parse(now) + 60_000 },
		})
		expect(outcome).toMatchObject({
			kind: 'queued',
			contextId: 'ec_mac',
			metadata: {
				attempts: [
					{ target: 'ec_mac', outcome: unavailable },
					{ target: 'ec_mac', outcome: 'queued' },
				],
			},
		})
		expect(s.enqueued).toHaveLength(1)
	})
}

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

test('a profile run takes a context only when granted it, and its lease carries the profile', async () => {
	const s = setup()
	addContext(s, { id: 'ec_mac' })
	setChain(s, operator, ['ec_mac'])
	const refused = await route(s, plainFiles['run.ts'], {
		profile: { id: 'prf_bot', grantedContexts: [] },
	})
	expect(refused.kind).not.toBe('ran')
	expect(s.dispatched).toHaveLength(0)
	const ran = await route(s, plainFiles['run.ts'], {
		profile: { id: 'prf_bot', grantedContexts: ['ec_mac'] },
	})
	expect(ran.kind).toBe('ran')
	expect(s.dispatched).toHaveLength(1)
	expect(s.dispatched[0]).toMatchObject({ lease: { profileId: 'prf_bot' } })
})
