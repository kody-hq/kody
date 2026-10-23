import { env } from 'cloudflare:workers'
import { afterEach, expect, test, vi } from 'vitest'
import { ensureCommunityFlowSchema } from '#worker/community/community-flow-test-schema.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { aggregateConnectionUsageDaily } from './connection-usage-rollup.ts'
import { loadConnectionUsage } from './connection-usage.ts'
import { recordUsage } from './record-usage.ts'
import { ensureUsageRollupsTestSchema } from './test-schema.ts'

// Wednesday: the cap week starts Monday 2026-10-05.
const now = new Date('2026-10-07T15:00:00.000Z')

const credentialedEnv = {
	...env,
	CLOUDFLARE_ACCOUNT_ID: 'acct',
	CLOUDFLARE_API_TOKEN: 'token',
	USAGE_EVENTS: {
		writeDataPoint() {},
	} as unknown as AnalyticsEngineDataset,
}

// Jobs fall back to APP_DB without the JOBS service binding.
const envWithoutJobsService = { ...env, JOBS: undefined } as unknown as Env

afterEach(() => {
	vi.unstubAllGlobals()
})

async function ensureSchema() {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	await ensureCommunityFlowSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS api_tokens (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL
		)`,
	).run()
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			source_id TEXT NOT NULL,
			published_commit TEXT,
			repo_check_policy_json TEXT,
			storage_id TEXT NOT NULL,
			params_json TEXT,
			schedule_json TEXT NOT NULL,
			timezone TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			kill_switch_enabled INTEGER NOT NULL DEFAULT 0,
			expires_at TEXT,
			caller_context_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_run_at TEXT,
			last_run_status TEXT,
			next_run_at TEXT NOT NULL,
			claim_token TEXT,
			running_since TEXT,
			lease_expires_at TEXT,
			claimed_scheduled_for TEXT,
			retry_scheduled_for TEXT,
			retry_count INTEGER NOT NULL DEFAULT 0,
			last_completed_scheduled_for TEXT
		)`,
	).run()
	await ensureSoftDeleteTestColumns(env.APP_DB, [
		'users',
		'orgs',
		'saved_packages',
		'api_tokens',
		'jobs',
	])
}

async function seedPerson(label: string) {
	const email = `conn-usage-${label}-${crypto.randomUUID()}@example.com`
	const personId = testStableUserIdFromEmail(email)
	const username = `${label}${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
		 VALUES (?, ?, 'hash', ?)`,
	)
		.bind(username, email, personId)
		.run()
	return { personId, username }
}

async function seedTeamOrg() {
	const orgId = testStableUserIdFromEmail(
		`conn-usage-org-${crypto.randomUUID()}@example.com`,
	)
	const slug = `team${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
	const stamp = now.toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
		 VALUES (?, ?, 'free', ?, ?)`,
	)
		.bind(orgId, slug, stamp, stamp)
		.run()
	return { orgId, slug }
}

async function seedPackage(orgId: string, name: string) {
	const id = crypto.randomUUID()
	await env.APP_DB.prepare(
		`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
		 VALUES (?, ?, ?, ?, '', ?)`,
	)
		.bind(id, orgId, name, name, `source-${id}`)
		.run()
	return id
}

async function seedJob(orgId: string, name: string) {
	const id = crypto.randomUUID()
	const stamp = now.toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO jobs (
			id, user_id, name, source_id, storage_id, schedule_json, timezone,
			caller_context_json, created_at, updated_at, next_run_at
		) VALUES (?, ?, ?, ?, ?, ?, 'UTC', 'null', ?, ?, ?)`,
	)
		.bind(
			id,
			orgId,
			name,
			`source-${id}`,
			`job:${id}`,
			JSON.stringify({ type: 'interval', every: '1m' }),
			stamp,
			stamp,
			stamp,
		)
		.run()
	return id
}

async function insertUsageRow(input: {
	orgId: string
	day: string
	connectionKey: [kind: string, holder: string, credentialId: string]
	packageId?: string
	eventType: string
	units: number
}) {
	const [kind, holder, credentialId] = input.connectionKey
	await env.APP_DB.prepare(
		`INSERT INTO usage_connection_daily (
			user_id, day, credential_kind, holder_user_id, credential_id,
			package_id, event_type, units, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			input.orgId,
			input.day,
			kind,
			holder,
			credentialId,
			input.packageId ?? '',
			input.eventType,
			input.units,
			`${input.day}T12:00:00.000Z`,
		)
		.run()
}

async function listStoredRows(orgId: string) {
	const { results } = await env.APP_DB.prepare(
		`SELECT day, credential_kind, holder_user_id, credential_id, package_id,
			event_type, units
		 FROM usage_connection_daily WHERE user_id = ?
		 ORDER BY day, credential_kind, credential_id, package_id, event_type`,
	)
		.bind(orgId)
		.all()
	return results
}

function stubAnalytics(rows: Array<Record<string, unknown>>) {
	const fetchMock = vi.fn(
		async () => new Response(JSON.stringify({ data: rows }), { status: 200 }),
	)
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

test('aggregateConnectionUsageDaily rewrites yesterday and today, drops rows gone from yesterday, and prunes old days', async () => {
	await ensureSchema()
	const { personId } = await seedPerson('holder')
	const { orgId } = await seedTeamOrg()
	const agentKey = `mcp-oauth:${personId}:https://agent.example/client.json`
	await insertUsageRow({
		orgId,
		day: '2026-09-20',
		connectionKey: ['mcp-oauth', personId, 'old'],
		eventType: 'execute',
		units: 4,
	})
	await insertUsageRow({
		orgId,
		day: '2026-10-06',
		connectionKey: ['cli', personId, 'gone'],
		eventType: 'execute',
		units: 2,
	})
	// Today's groups can lag in Analytics Engine, so a missing one stays.
	await insertUsageRow({
		orgId,
		day: '2026-10-07',
		connectionKey: ['cli', personId, 'lagging'],
		eventType: 'execute',
		units: 2,
	})

	stubAnalytics([
		{
			user_id: orgId,
			day: '2026-10-06',
			connection_key: agentKey,
			package_id: 'pkg-1',
			event_type: 'execute',
			units: 3,
		},
		{
			user_id: orgId,
			day: '2026-10-07 00:00:00',
			connection_key: agentKey,
			package_id: '',
			event_type: 'dynamic_worker_day',
			units: '5',
		},
		{
			user_id: orgId,
			day: '2026-10-07',
			connection_key: '',
			package_id: '',
			event_type: 'execute',
			units: 1,
		},
		{
			user_id: orgId,
			day: '2026-10-07',
			connection_key: agentKey,
			package_id: '',
			event_type: 'job_run',
			units: 9,
		},
		{
			user_id: 'deleted-owner',
			day: '2026-10-07',
			connection_key: agentKey,
			package_id: '',
			event_type: 'execute',
			units: 9,
		},
	])
	expect(await aggregateConnectionUsageDaily(credentialedEnv, now)).toEqual({
		skipped: false,
		upserted: 3,
		deleted: 1,
		pruned: 1,
	})
	const client = 'https://agent.example/client.json'
	expect(await listStoredRows(orgId)).toEqual([
		{
			day: '2026-10-06',
			credential_kind: 'mcp-oauth',
			holder_user_id: personId,
			credential_id: client,
			package_id: 'pkg-1',
			event_type: 'execute',
			units: 3,
		},
		{
			day: '2026-10-07',
			credential_kind: '',
			holder_user_id: '',
			credential_id: '',
			package_id: '',
			event_type: 'execute',
			units: 1,
		},
		{
			day: '2026-10-07',
			credential_kind: 'cli',
			holder_user_id: personId,
			credential_id: 'lagging',
			package_id: '',
			event_type: 'execute',
			units: 2,
		},
		{
			day: '2026-10-07',
			credential_kind: 'mcp-oauth',
			holder_user_id: personId,
			credential_id: client,
			package_id: '',
			event_type: 'dynamic_worker_day',
			units: 5,
		},
	])

	// Unchanged Analytics Engine rows are not rewritten.
	stubAnalytics([
		{
			user_id: orgId,
			day: '2026-10-06',
			connection_key: agentKey,
			package_id: 'pkg-1',
			event_type: 'execute',
			units: 3,
		},
		{
			user_id: orgId,
			day: '2026-10-07',
			connection_key: agentKey,
			package_id: '',
			event_type: 'dynamic_worker_day',
			units: 6,
		},
		{
			user_id: orgId,
			day: '2026-10-07',
			connection_key: '',
			package_id: '',
			event_type: 'execute',
			units: 1,
		},
	])
	expect(await aggregateConnectionUsageDaily(credentialedEnv, now)).toEqual({
		skipped: false,
		upserted: 1,
		deleted: 0,
		pruned: 0,
	})

	// An empty result looks like ingestion lag; stored rows stay.
	stubAnalytics([])
	await aggregateConnectionUsageDaily(credentialedEnv, now)
	expect(await listStoredRows(orgId)).toHaveLength(4)
})

test('recordUsage without Analytics Engine adds units to the connection row', async () => {
	await ensureSchema()
	const { personId } = await seedPerson('local')
	const { orgId } = await seedTeamOrg()
	const connectionKey = `api-token:${personId}:tok_1`
	for (const eventType of ['execute', 'execute', 'job_run'] as const) {
		await recordUsage(
			{ APP_DB: env.APP_DB },
			{
				userId: orgId,
				eventType,
				outcome: 'success',
				packageId: 'pkg-9',
				connectionKey,
				timestamp: '2026-10-07T09:00:00.000Z',
			},
		)
	}
	expect(await listStoredRows(orgId)).toEqual([
		{
			day: '2026-10-07',
			credential_kind: 'api-token',
			holder_user_id: personId,
			credential_id: 'tok_1',
			package_id: 'pkg-9',
			event_type: 'execute',
			units: 2,
		},
	])
})

async function seedTeamUsage() {
	await ensureSchema()
	const viewer = await seedPerson('viewer')
	const teammate = await seedPerson('teammate')
	const { orgId, slug } = await seedTeamOrg()
	const pollerId = await seedPackage(orgId, 'slack-poller')
	const jobId = await seedJob(orgId, 'Poll Slack')
	const client = 'https://bot.example/client.json'
	const suffix = crypto.randomUUID().slice(0, 8)
	const viewerTokenId = `tok_viewer_${suffix}`
	const teammateTokenId = `tok_teammate_${suffix}`
	await env.APP_DB.prepare(
		`INSERT INTO api_tokens (id, user_id, name) VALUES (?, ?, ?), (?, ?, ?)`,
	)
		.bind(
			viewerTokenId,
			viewer.personId,
			'Brad laptop',
			teammateTokenId,
			teammate.personId,
			'Teammate secret token',
		)
		.run()
	const rows: Array<Parameters<typeof insertUsageRow>[0]> = [
		// Viewer's agent: today, Monday (cap week), and last Friday (7 days only).
		{
			orgId,
			day: '2026-10-07',
			connectionKey: ['mcp-oauth', viewer.personId, client],
			packageId: pollerId,
			eventType: 'execute',
			units: 40,
		},
		{
			orgId,
			day: '2026-10-07',
			connectionKey: ['mcp-oauth', viewer.personId, client],
			packageId: pollerId,
			eventType: 'dynamic_worker_day',
			units: 1,
		},
		{
			orgId,
			day: '2026-10-05',
			connectionKey: ['mcp-oauth', viewer.personId, client],
			eventType: 'execute',
			units: 10,
		},
		{
			orgId,
			day: '2026-10-02',
			connectionKey: ['mcp-oauth', viewer.personId, client],
			eventType: 'execute',
			units: 100,
		},
		// Outside the 7-day window.
		{
			orgId,
			day: '2026-09-30',
			connectionKey: ['mcp-oauth', viewer.personId, client],
			eventType: 'execute',
			units: 1000,
		},
		{
			orgId,
			day: '2026-10-06',
			connectionKey: ['api-token', viewer.personId, viewerTokenId],
			eventType: 'dynamic_worker_invoke',
			units: 3,
		},
		{
			orgId,
			day: '2026-10-07',
			connectionKey: ['api-token', teammate.personId, teammateTokenId],
			packageId: pollerId,
			eventType: 'execute',
			units: 7,
		},
		{
			orgId,
			day: '2026-10-07',
			connectionKey: ['schedule', '', jobId],
			packageId: pollerId,
			eventType: 'execute',
			units: 1440,
		},
		{
			orgId,
			day: '2026-10-07',
			connectionKey: ['', '', ''],
			eventType: 'execute',
			units: 2,
		},
	]
	for (const row of rows) await insertUsageRow(row)
	return {
		viewer,
		teammate,
		orgId,
		slug,
		pollerId,
		jobId,
		client,
		viewerTokenId,
	}
}

const counts = (executeCalls: number, workerLoads = 0, runs = 0) => ({
	executeCalls,
	workerLoads,
	runs,
})

test('members see only their own connections, never teammates or Automation', async () => {
	const { viewer, orgId, slug, pollerId, client, viewerTokenId } =
		await seedTeamUsage()
	const usage = await loadConnectionUsage({
		env: envWithoutJobsService,
		orgId,
		orgSlug: slug,
		viewerPersonId: viewer.personId,
		includeOrgWide: false,
		canSeePackage: () => true,
		now,
	})
	expect(usage.windows).toEqual({
		today: { startDay: '2026-10-07', endDay: '2026-10-07' },
		capWeek: { startDay: '2026-10-05', endDay: '2026-10-07' },
		last7Days: { startDay: '2026-10-01', endDay: '2026-10-07' },
	})
	expect(usage.automations).toBeNull()
	expect(usage.people).toBeNull()
	expect(usage.unattributed).toBeNull()
	expect(usage.retentionDays).toBe(14)
	expect(usage.updatedAt).toBe('2026-10-07T12:00:00.000Z')
	expect(usage.connections).toEqual([
		{
			id: `mcp-oauth:${client}`,
			credentialKind: 'mcp-oauth',
			credentialId: client,
			label: null,
			totals: {
				today: counts(40, 1),
				capWeek: counts(50, 1),
				last7Days: counts(150, 1),
			},
			callers: [
				{
					packageId: pollerId,
					label: 'slack-poller',
					href: `/@${slug}/slack-poller`,
					totals: {
						today: counts(40, 1),
						capWeek: counts(40, 1),
						last7Days: counts(40, 1),
					},
				},
				{
					packageId: '',
					label: 'Ad hoc code',
					href: null,
					totals: {
						today: counts(0),
						capWeek: counts(10),
						last7Days: counts(110),
					},
				},
			],
		},
		{
			id: `api-token:${viewerTokenId}`,
			credentialKind: 'api-token',
			credentialId: viewerTokenId,
			label: 'Brad laptop',
			totals: {
				today: counts(0),
				capWeek: counts(0, 0, 3),
				last7Days: counts(0, 0, 3),
			},
			callers: [
				{
					packageId: '',
					label: 'Ad hoc code',
					href: null,
					totals: {
						today: counts(0),
						capWeek: counts(0, 0, 3),
						last7Days: counts(0, 0, 3),
					},
				},
			],
		},
	])
	expect(JSON.stringify(usage)).not.toContain('Teammate secret token')
	expect(JSON.stringify(usage)).not.toContain('tok_teammate')
})

test('team packages the viewer cannot see keep their units but not their name', async () => {
	const { viewer, orgId, slug, pollerId } = await seedTeamUsage()
	async function pollerCaller(canSee: boolean) {
		const usage = await loadConnectionUsage({
			env: envWithoutJobsService,
			orgId,
			orgSlug: slug,
			viewerPersonId: viewer.personId,
			includeOrgWide: false,
			canSeePackage: (packageId) => canSee || packageId !== pollerId,
			now,
		})
		return usage.connections[0]?.callers.find(
			(caller) => caller.packageId === pollerId,
		)
	}
	expect(await pollerCaller(true)).toMatchObject({
		label: 'slack-poller',
		href: `/@${slug}/slack-poller`,
	})
	const hidden = await pollerCaller(false)
	expect(hidden).toMatchObject({
		label: 'Package you cannot see',
		href: null,
		totals: { last7Days: counts(40, 1) },
	})
	expect(JSON.stringify(hidden)).not.toContain('slack-poller')
})

test('billing readers also see Automation, teammates by username only, and untracked units', async () => {
	const { viewer, teammate, orgId, slug, jobId, viewerTokenId } =
		await seedTeamUsage()
	const usage = await loadConnectionUsage({
		env: envWithoutJobsService,
		orgId,
		orgSlug: slug,
		viewerPersonId: viewer.personId,
		includeOrgWide: true,
		canSeePackage: () => true,
		now,
	})
	expect(usage.connections.map((entry) => entry.id)).toEqual([
		'mcp-oauth:https://bot.example/client.json',
		`api-token:${viewerTokenId}`,
	])
	expect(usage.automations).toEqual([
		expect.objectContaining({
			id: `schedule:${jobId}`,
			credentialKind: 'schedule',
			label: 'Poll Slack',
			href: `/@${slug}/-/jobs/${jobId}`,
			totals: {
				today: counts(1440),
				capWeek: counts(1440),
				last7Days: counts(1440),
			},
		}),
	])
	expect(usage.people).toEqual([
		{
			username: teammate.username,
			totals: {
				today: counts(7),
				capWeek: counts(7),
				last7Days: counts(7),
			},
		},
	])
	expect(usage.unattributed).toEqual({
		today: counts(2),
		capWeek: counts(2),
		last7Days: counts(2),
	})
	// Teammates' credentials and token names stay private.
	expect(JSON.stringify(usage)).not.toContain('Teammate secret token')
	expect(JSON.stringify(usage)).not.toContain('tok_teammate')
})

test('connection usage never reads another org', async () => {
	const { viewer } = await seedTeamUsage()
	const other = await seedTeamOrg()
	const usage = await loadConnectionUsage({
		env: envWithoutJobsService,
		orgId: other.orgId,
		orgSlug: other.slug,
		viewerPersonId: viewer.personId,
		includeOrgWide: true,
		canSeePackage: () => true,
		now,
	})
	expect(usage.connections).toEqual([])
	expect(usage.automations).toEqual([])
	expect(usage.people).toEqual([])
	expect(usage.updatedAt).toBeNull()
})
