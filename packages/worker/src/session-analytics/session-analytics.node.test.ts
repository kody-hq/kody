import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { updateOrgSessionAnalytics } from './consent.ts'
import {
	deleteSessionInsights,
	loadPackageSessionInsights,
	loadSessionInsights,
	loadStuckPatterns,
} from './insights.ts'
import {
	categoryNamePassesPrecheck,
	labelSessionCategory,
	sessionCategoryJudgeModel,
	sessionCategoryModel,
	type SessionAiRunner,
} from './labeler.ts'
import { sessionNudgeLine } from './nudges.ts'
import {
	classifyStuckKind,
	observeSessionToolCall,
	recordSessionCall,
} from './record.ts'
import {
	applySessionCall,
	newOpenSession,
	sessionCountsRetentionDays,
	sessionResult,
	sweepSessionAnalytics,
} from './store.ts'
import { categoryMergeKey, mergeNearDuplicateCategories } from './weekly.ts'

const now = new Date('2026-11-27T12:00:00.000Z')

function createTestDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function seedOrg(
	sqlite: DatabaseSync,
	id: string,
	state: 'unset' | 'enabled' | 'declined',
) {
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at, session_analytics)
			 VALUES (?, ?, 'free', ?, ?, ?)`,
		)
		.run(id, id, now.toISOString(), now.toISOString(), state)
}

function callerFor(orgId: string, userId = 'person-1') {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.example',
		user: {
			userId: personIdFromStored(userId),
			email: `${userId}@example.com`,
			displayName: 'Person',
		},
		orgBinding: {
			org: { id: ownerIdFromStored(orgId), slug: orgId },
			role: 'owner',
		},
	})
}

function tableCount(sqlite: DatabaseSync, table: string) {
	const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
		n: number
	}
	return row.n
}

const analyticsTables = [
	'session_analytics_open_sessions',
	'session_analytics_links',
	'session_analytics_counts',
	'session_analytics_package_counts',
	'session_analytics_label_stats',
	'session_analytics_categories',
]

/** A category model that reuses a listed category, and a judge that is never needed. */
function reuseAi(category: string, calls: Array<string> = []): SessionAiRunner {
	return async (model) => {
		calls.push(model)
		return { answers: { category: { value: category } } }
	}
}

/** A model that always proposes new names in order, with a judge verdict per name. */
function proposingAi(
	proposals: ReadonlyArray<string>,
	judge: (name: string) => number,
	seen: Array<{ model: string; body: unknown }> = [],
): SessionAiRunner {
	let index = 0
	return async (model, body) => {
		seen.push({ model, body })
		if (model === sessionCategoryModel) {
			const proposed = proposals[index++] ?? null
			return {
				answers: {
					category: { value: 'none_fit' },
					new_category: { value: proposed },
				},
			}
		}
		const name = (body as { state: { name: string } }).state.name
		return { answers: { user_data: { noul: judge(name) } } }
	}
}

function insertCounts(
	sqlite: DatabaseSync,
	rows: ReadonlyArray<{
		org: string
		user?: string
		day?: string
		category?: string
		outcome?: string
		stuckKind?: string
		stuckTool?: string
		sessions: number
	}>,
) {
	for (const row of rows) {
		sqlite
			.prepare(
				`INSERT INTO session_analytics_counts (
					org_id, user_id, day, category_id, outcome, stuck_kind, stuck_tool,
					client_name, surface, sessions, linked_sessions, calls, errors
				) VALUES (?, ?, ?, ?, ?, ?, ?, 'cursor', 'mcp', ?, ?, ?, ?)`,
			)
			.run(
				row.org,
				row.user ?? 'person-1',
				row.day ?? '2026-11-26',
				row.category ?? '',
				row.outcome ?? 'succeeded',
				row.stuckKind ?? '',
				row.stuckTool ?? '',
				row.sessions,
				row.sessions,
				row.sessions * 3,
				row.outcome === 'stuck' ? row.sessions * 2 : 0,
			)
	}
}

function insertPackageCounts(
	sqlite: DatabaseSync,
	rows: ReadonlyArray<{
		org: string
		outcome?: string
		stuckKind?: string
		sessions: number
	}>,
) {
	for (const row of rows) {
		sqlite
			.prepare(
				`INSERT INTO session_analytics_package_counts (
					package_id, org_id, user_id, day, outcome, stuck_kind, sessions
				) VALUES ('pkg-1', ?, 'person-1', '2026-11-26', ?, ?, ?)`,
			)
			.run(
				row.org,
				row.outcome ?? 'succeeded',
				row.stuckKind ?? '',
				row.sessions,
			)
	}
}

test('nothing is stored and no model runs until the org turns analytics on', async () => {
	const { sqlite, db } = createTestDb()
	seedOrg(sqlite, 'org-unset', 'unset')
	seedOrg(sqlite, 'org-declined', 'declined')
	const modelCalls: Array<string> = []
	for (const orgId of ['org-unset', 'org-declined']) {
		await recordSessionCall({
			env: { APP_DB: db } as Env,
			callerContext: callerFor(orgId),
			tool: 'execute',
			links: [{ kind: 'conversation', key: 'conv-1' }],
			memoryContext: { task: 'Connect the billing service' },
			stuckKind: 'validation',
			ai: reuseAi('connect service', modelCalls),
			now,
		})
	}
	expect(modelCalls).toEqual([])
	for (const table of analyticsTables) {
		expect(tableCount(sqlite, table), table).toBe(0)
	}
})

test('an opted-in session keeps counts and a category, and never the task text', async () => {
	const { sqlite, db } = createTestDb()
	seedOrg(sqlite, 'org-on', 'enabled')
	const env = { APP_DB: db } as Env
	const secretTask = 'Reconcile invoices for Acme Rocketry with Dana'
	const links = [{ kind: 'conversation' as const, key: 'conv-1' }]
	await recordSessionCall({
		env,
		callerContext: callerFor('org-on'),
		tool: 'search',
		links,
		memoryContext: { task: secretTask, entities: ['Acme Rocketry'] },
		stuckKind: null,
		ai: reuseAi('connect service'),
		now,
	})
	await recordSessionCall({
		env,
		callerContext: callerFor('org-on'),
		tool: 'execute',
		links,
		stuckKind: null,
		ai: reuseAi('connect service'),
		now: new Date(now.getTime() + 60_000),
	})
	expect(tableCount(sqlite, 'session_analytics_open_sessions')).toBe(1)

	const swept = await sweepSessionAnalytics(
		db,
		new Date(now.getTime() + 2 * 60 * 60 * 1000),
	)
	expect(swept).toEqual({ closed: 1 })
	expect(tableCount(sqlite, 'session_analytics_open_sessions')).toBe(0)
	expect(tableCount(sqlite, 'session_analytics_links')).toBe(0)

	const view = await loadSessionInsights(db, {
		owner: { orgId: 'org-on', userId: 'person-1' },
		now: new Date(now.getTime() + 2 * 60 * 60 * 1000),
	})
	expect(view.entries).toEqual([
		expect.objectContaining({
			categoryName: 'connect service',
			outcome: 'succeeded',
			sessions: 1,
			calls: 2,
			errors: 0,
		}),
	])
	const everything = analyticsTables
		.map((table) =>
			JSON.stringify(sqlite.prepare(`SELECT * FROM ${table}`).all()),
		)
		.join('\n')
	expect(everything).not.toMatch(/acme|rocketry|dana|invoice/i)
})

test('calls with no shared id are never joined into one session by time', async () => {
	const { sqlite, db } = createTestDb()
	seedOrg(sqlite, 'org-on', 'enabled')
	for (const key of ['conv-1', 'conv-2']) {
		await recordSessionCall({
			env: { APP_DB: db } as Env,
			callerContext: callerFor('org-on'),
			tool: 'execute',
			links: [{ kind: 'conversation', key }],
			stuckKind: null,
			now,
		})
	}
	expect(tableCount(sqlite, 'session_analytics_open_sessions')).toBe(2)
})

test('turning analytics off deletes every row stored for the org', async () => {
	const { sqlite, db } = createTestDb()
	seedOrg(sqlite, 'org-on', 'enabled')
	seedOrg(sqlite, 'org-other', 'enabled')
	insertCounts(sqlite, [
		{ org: 'org-on', sessions: 4 },
		{ org: 'org-other', sessions: 2 },
	])
	insertPackageCounts(sqlite, [{ org: 'org-on', sessions: 4 }])
	await recordSessionCall({
		env: { APP_DB: db } as Env,
		callerContext: callerFor('org-on'),
		tool: 'execute',
		links: [{ kind: 'conversation', key: 'conv-1' }],
		stuckKind: null,
		now,
	})
	const result = await updateOrgSessionAnalytics(db, {
		orgId: 'org-on',
		enabled: false,
		audit: createTestOrgAuditWriter(),
	})
	expect(result).toEqual({ ok: true, state: 'declined', changed: true })
	for (const table of [
		'session_analytics_open_sessions',
		'session_analytics_links',
		'session_analytics_counts',
		'session_analytics_package_counts',
	]) {
		const row = sqlite
			.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id = 'org-on'`)
			.get() as { n: number }
		expect(row.n, table).toBe(0)
	}
	expect(tableCount(sqlite, 'session_analytics_counts')).toBe(1)
})

test('the name pre-check allows only a few plain lowercase words', () => {
	for (const name of ['connect service', 'manage files', 'send email now']) {
		expect(categoryNamePassesPrecheck(name), name).toBe(true)
	}
	for (const name of [
		'',
		'a',
		'fix acme-corp invoice',
		'dana@example.com',
		'ticket 4821',
		'Connect Service',
		'one two three four five',
		'none_fit',
		'uncategorized',
		'antidisestablishmentarianism things',
	]) {
		expect(categoryNamePassesPrecheck(name), name).toBe(false)
	}
})

test('a rejected category name is regenerated, and the judge sees only the name', async () => {
	const { sqlite, db } = createTestDb()
	const seen: Array<{ model: string; body: unknown }> = []
	const task = 'Task: Reconcile invoices for Acme Rocketry'
	const labeled = await labelSessionCategory({
		db,
		ai: proposingAi(
			['fix acme-corp invoice', 'acme invoices', 'reconcile invoices'],
			(name) => (name === 'acme invoices' ? 0.9 : -0.9),
			seen,
		),
		task,
		now,
	})
	expect(labeled.stats).toMatchObject({
		labeled: 1,
		proposedPasses: 1,
		proposals: 3,
		rejectedPrecheck: 1,
		rejectedJudge: 1,
		accepted: 1,
		failedThreeAttempts: 0,
	})
	const row = sqlite
		.prepare(`SELECT id, name FROM session_analytics_categories`)
		.all()
	expect(row).toEqual([{ id: labeled.categoryId, name: 'reconcile invoices' }])
	const judgeCalls = seen.filter(
		(call) => call.model === sessionCategoryJudgeModel,
	)
	expect(judgeCalls).toHaveLength(2)
	expect(JSON.stringify(judgeCalls)).not.toMatch(
		/rocketry|reconcile invoices for/i,
	)
})

test('three rejected names leave the session uncategorized and count a failure', async () => {
	const { sqlite, db } = createTestDb()
	const seen: Array<{ model: string; body: unknown }> = []
	const labeled = await labelSessionCategory({
		db,
		ai: proposingAi(
			['acme invoices', 'acme work', 'acme things', 'fine name'],
			() => 0.9,
			seen,
		),
		task: 'Task: anything',
		now,
	})
	expect(labeled.categoryId).toBeNull()
	expect(labeled.stats).toMatchObject({
		proposals: 3,
		rejectedJudge: 3,
		accepted: 0,
		failedThreeAttempts: 1,
		modelFailed: 0,
	})
	expect(
		seen.filter((call) => call.model === sessionCategoryModel),
	).toHaveLength(3)
	expect(tableCount(sqlite, 'session_analytics_categories')).toBe(0)
})

test('a model failure ends as uncategorized instead of failing the call', async () => {
	const { db } = createTestDb()
	const labeled = await labelSessionCategory({
		db,
		ai: async () => {
			throw new Error('model unavailable')
		},
		task: 'Task: anything',
		now,
	})
	expect(labeled.categoryId).toBeNull()
	expect(labeled.stats.modelFailed).toBe(1)
})

test('insights can be deleted per entry or all at once, scoped to their owner', async () => {
	const { sqlite, db } = createTestDb()
	seedOrg(sqlite, 'org-on', 'enabled')
	insertCounts(sqlite, [
		{ org: 'org-on', user: 'person-1', sessions: 3 },
		{
			org: 'org-on',
			user: 'person-1',
			outcome: 'stuck',
			stuckKind: 'validation',
			stuckTool: 'execute',
			sessions: 2,
		},
		{ org: 'org-on', user: 'person-2', sessions: 5 },
		{ org: 'org-other', user: 'person-1', sessions: 7 },
	])
	const mine = { orgId: 'org-on', userId: 'person-1' }
	await deleteSessionInsights(db, {
		owner: mine,
		entry: {
			categoryId: '',
			outcome: 'stuck',
			stuckKind: 'validation',
			stuckTool: 'execute',
		},
	})
	expect((await loadSessionInsights(db, { owner: mine, now })).entries).toEqual(
		[expect.objectContaining({ outcome: 'succeeded', sessions: 3 })],
	)

	await deleteSessionInsights(db, { owner: mine })
	expect((await loadSessionInsights(db, { owner: mine, now })).entries).toEqual(
		[],
	)
	const org = await loadSessionInsights(db, { owner: { orgId: 'org-on' }, now })
	expect(org.entries.map((entry) => entry.sessions)).toEqual([5])
	const other = sqlite
		.prepare(
			`SELECT sessions FROM session_analytics_counts WHERE org_id = 'org-other'`,
		)
		.all()
	expect(other).toEqual([{ sessions: 7 }])
})

test('a nudge needs a repeat of the same error and a kind with a clear next step', () => {
	expect(
		sessionNudgeLine({ stuckKind: 'validation', priorStreak: 0 }),
	).toBeNull()
	expect(sessionNudgeLine({ stuckKind: 'validation', priorStreak: 1 })).toBe(
		'Kody note: this call has now failed 2 times in a row for invalid input. Next step: reread the input schema for this call and change the arguments before retrying.',
	)
	for (const stuckKind of ['user_code', 'platform', 'other'] as const) {
		expect(sessionNudgeLine({ stuckKind, priorStreak: 5 })).toBeNull()
	}
})

test('a repeated failure in an opted-in session gets one added line, and only there', async () => {
	const { sqlite, db } = createTestDb()
	seedOrg(sqlite, 'org-on', 'enabled')
	seedOrg(sqlite, 'org-off', 'unset')
	const failure = () => ({
		isError: true,
		content: [{ type: 'text' as const, text: 'Invalid input' }],
		structuredContent: { error: 'Invalid input: expected string' },
	})
	async function fail(orgId: string, tool: string, conversationId: string) {
		return observeSessionToolCall({
			env: { APP_DB: db } as Env,
			callerContext: callerFor(orgId),
			tool,
			conversationId,
			run: async () => failure(),
		})
	}
	expect((await fail('org-on', 'execute', 'conv-1')).content).toHaveLength(1)
	const second = await fail('org-on', 'execute', 'conv-1')
	expect(second.content).toHaveLength(2)
	expect(second.content[1]?.text).toMatch(/^Kody note: .*2 times in a row/)

	// A different tool, a different session, and an org that is off get nothing.
	expect((await fail('org-on', 'search', 'conv-1')).content).toHaveLength(1)
	expect((await fail('org-on', 'execute', 'conv-2')).content).toHaveLength(1)
	await fail('org-off', 'execute', 'conv-3')
	expect((await fail('org-off', 'execute', 'conv-3')).content).toHaveLength(1)
})

test('session outcomes come from the counters alone', () => {
	const start = newOpenSession({
		orgId: 'org-on',
		userId: 'person-1',
		clientName: 'cursor',
		surface: 'mcp',
		now,
	})
	const ok = { tool: 'execute', stuckKind: null }
	const bad = { tool: 'execute', stuckKind: 'validation' as const }
	const run = (calls: ReadonlyArray<typeof ok | typeof bad>) =>
		sessionResult(
			calls.reduce(
				(session, call) => applySessionCall(session, call, now),
				start,
			),
		)
	expect(run([ok]).outcome).toBe('unknown')
	expect(run([ok, ok]).outcome).toBe('succeeded')
	expect(run([bad, bad, ok])).toEqual({
		outcome: 'recovered',
		stuckKind: 'validation',
		stuckTool: 'execute',
	})
	expect(run([ok, bad, bad])).toEqual({
		outcome: 'stuck',
		stuckKind: 'validation',
		stuckTool: 'execute',
	})
	expect(run([ok, ok, bad]).outcome).toBe('abandoned')
})

test('failed results map to a closed error kind', () => {
	const kind = (structuredContent: Record<string, unknown>) =>
		classifyStuckKind({ isError: true, structuredContent })
	expect(kind({ entitlement: { resource: 'execute' } })).toBe('entitlement')
	expect(kind({ error: 'Secret "stripe" not found' })).toBe(
		'credential_missing',
	)
	expect(kind({ error: 'Host api.example.com not allowed' })).toBe(
		'credential_denied',
	)
	expect(kind({ error: 'Request timed out' })).toBe('timeout')
	expect(kind({ error: 'Package @a/b does not exist' })).toBe('not_found')
	expect(kind({ errorName: 'TypeError', error: 'x is undefined' })).toBe(
		'user_code',
	)
	expect(kind({ error: 'something odd' })).toBe('other')
})

test('publisher totals stay hidden until 10 sessions from 5 organizations', async () => {
	const { sqlite, db } = createTestDb()
	// Many sessions, too few organizations.
	insertPackageCounts(sqlite, [
		{ org: 'org-1', sessions: 30 },
		{ org: 'org-2', sessions: 30 },
		{ org: 'org-3', sessions: 30 },
		{ org: 'org-4', sessions: 30 },
	])
	const input = { packageId: 'pkg-1', now }
	expect(await loadPackageSessionInsights(db, input)).toEqual({
		available: false,
		minSessions: 10,
		minOrgs: 5,
		windowDays: 30,
	})

	insertPackageCounts(sqlite, [
		{ org: 'org-5', sessions: 1 },
		// A stuck kind seen in only two organizations stays out of the result.
		{ org: 'org-1', outcome: 'stuck', stuckKind: 'timeout', sessions: 20 },
		{ org: 'org-2', outcome: 'stuck', stuckKind: 'timeout', sessions: 20 },
		...['org-1', 'org-2', 'org-3', 'org-4', 'org-5'].map((org) => ({
			org,
			outcome: 'stuck',
			stuckKind: 'validation',
			sessions: 2,
		})),
	])
	const shown = await loadPackageSessionInsights(db, input)
	expect(shown).toEqual({
		available: true,
		windowDays: 30,
		sessions: 171,
		orgs: 5,
		endedWithoutErrors: 121,
		stuckKinds: [{ stuckKind: 'validation', sessions: 10 }],
	})
	expect(JSON.stringify(shown)).not.toMatch(/org-\d|person-/)
})

test('stuck patterns across organizations need the same minimum', async () => {
	const { sqlite, db } = createTestDb()
	const stuck = {
		outcome: 'stuck',
		stuckKind: 'validation',
		stuckTool: 'execute',
	}
	insertCounts(sqlite, [
		{ org: 'org-1', ...stuck, sessions: 50 },
		{ org: 'org-2', ...stuck, sessions: 50 },
	])
	expect(await loadStuckPatterns(db, { since: '2026-11-01' })).toEqual([])
	insertCounts(
		sqlite,
		['org-3', 'org-4', 'org-5'].map((org) => ({ org, ...stuck, sessions: 1 })),
	)
	expect(await loadStuckPatterns(db, { since: '2026-11-01' })).toEqual([
		expect.objectContaining({
			stuckKind: 'validation',
			stuckTool: 'execute',
			sessions: 103,
			orgs: 5,
		}),
	])
})

test('the sweep deletes counts past retention and sessions of orgs that are off', async () => {
	const { sqlite, db } = createTestDb()
	seedOrg(sqlite, 'org-on', 'enabled')
	const dayAgo = (days: number) =>
		new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10)
	insertCounts(sqlite, [
		{ org: 'org-on', day: dayAgo(sessionCountsRetentionDays + 1), sessions: 1 },
		{ org: 'org-on', day: dayAgo(sessionCountsRetentionDays - 1), sessions: 2 },
	])
	await recordSessionCall({
		env: { APP_DB: db } as Env,
		callerContext: callerFor('org-on'),
		tool: 'execute',
		links: [{ kind: 'conversation', key: 'conv-1' }],
		stuckKind: null,
		now,
	})
	sqlite
		.prepare(
			`UPDATE orgs SET session_analytics = 'declined' WHERE id = 'org-on'`,
		)
		.run()
	await sweepSessionAnalytics(db, now)
	expect(tableCount(sqlite, 'session_analytics_open_sessions')).toBe(0)
	expect(tableCount(sqlite, 'session_analytics_links')).toBe(0)
	expect(
		sqlite.prepare(`SELECT sessions FROM session_analytics_counts`).all(),
	).toEqual([{ sessions: 2 }])
})

test('the weekly pass merges category names that differ only by order or endings', async () => {
	const { sqlite, db } = createTestDb()
	expect(categoryMergeKey('managing files')).toBe(
		categoryMergeKey('file manage'),
	)
	const insert = sqlite.prepare(
		`INSERT INTO session_analytics_categories (id, name, created_at) VALUES (?, ?, ?)`,
	)
	insert.run('cat-1', 'manage files', '2026-11-01T00:00:00.000Z')
	insert.run('cat-2', 'managing file', '2026-11-02T00:00:00.000Z')
	insert.run('cat-3', 'send email', '2026-11-03T00:00:00.000Z')
	expect(await mergeNearDuplicateCategories(db)).toEqual([
		{
			from: { id: 'cat-2', name: 'managing file' },
			into: { id: 'cat-1', name: 'manage files' },
		},
	])
	expect(
		sqlite
			.prepare(
				`SELECT id, status, merged_into FROM session_analytics_categories ORDER BY id`,
			)
			.all(),
	).toEqual([
		{ id: 'cat-1', status: 'active', merged_into: null },
		{ id: 'cat-2', status: 'merged', merged_into: 'cat-1' },
		{ id: 'cat-3', status: 'active', merged_into: null },
	])
})
