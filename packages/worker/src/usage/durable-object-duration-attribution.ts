/**
 * Per-user Durable Object duration from Cloudflare's own measurement.
 *
 * Cloudflare bills DO duration on wall-clock time an object is active (not
 * hibernation-eligible), at 128 MB. It reports that per object as
 * `activeTime` (microseconds) in GraphQL `durableObjectsPeriodicGroups`.
 * Object ids are `idFromName` hashes, so this lane rebuilds the id for every
 * frozen per-user name it can enumerate and maps Cloudflare's rows back to
 * owners. Unmappable objects (MCP session DOs, JobManager on kody-jobs,
 * discarded repo sessions, platform singletons) stay in the day's
 * unattributed total instead of being guessed.
 *
 * Output is an estimate of each user's share of the duration line, not an
 * invoice: Cloudflare applies the account-wide include and rounding to the
 * total, and objects sharing an isolate are still billed per object.
 */
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { repoSessionIdFromStorageBucketId } from '#worker/storage-buckets/service.ts'
import {
	mailboxDurableObjectName,
	mcpClientHubDurableObjectName,
	packageRealtimeSessionDurableObjectName,
	repoSessionDurableObjectName,
	repoSessionIndexDurableObjectName,
	runLogDurableObjectName,
	storageRunnerDurableObjectName,
	stripePlanRefreshDurableObjectName,
	userMeterDurableObjectName,
} from '#worker/user-scoped-durable-object-name.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { liveBillingOwnerSql } from '#worker/usage/live-billing-owner.ts'
export const durableObjectDurationAttributionObjectLimit = 10_000
const graphqlTimeoutMs = 30_000

type NamespaceLike = { idFromName(name: string): { toString(): string } }

export type DurableObjectDurationAttributionEnv = Pick<
	Env,
	| 'APP_DB'
	| 'MCP_CLIENT_HUB'
	| 'STORAGE_RUNNER'
	| 'RUN_LOG'
	| 'USER_METER'
	| 'MAILBOX'
	| 'REPO_SESSION_INDEX'
	| 'STRIPE_PLAN_REFRESH'
	| 'REPO_SESSION'
	| 'PACKAGE_REALTIME_SESSION'
> & {
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
}

export type DurableObjectOwner = { userId: string; doClass: string }

export type DurableObjectDurationAttributionResult =
	| { status: 'skipped'; reason: 'missing_credentials' }
	| {
			status: 'completed'
			days: Array<{
				day: string
				totalActiveMs: number
				attributedActiveMs: number
				objectCount: number
				attributedObjectCount: number
				truncated: boolean
				skipped: boolean
			}>
	  }

/** Per-user namespaces whose object name is the (trimmed) stable user id. */
function perUserNamespaces(env: DurableObjectDurationAttributionEnv) {
	return [
		['McpClientHub', env.MCP_CLIENT_HUB, mcpClientHubDurableObjectName],
		['RunLog', env.RUN_LOG, runLogDurableObjectName],
		['UserMeter', env.USER_METER, userMeterDurableObjectName],
		['Mailbox', env.MAILBOX, mailboxDurableObjectName],
		[
			'RepoSessionIndex',
			env.REPO_SESSION_INDEX,
			repoSessionIndexDurableObjectName,
		],
		[
			'StripePlanRefresh',
			env.STRIPE_PLAN_REFRESH,
			stripePlanRefreshDurableObjectName,
		],
	] as const satisfies ReadonlyArray<
		readonly [string, NamespaceLike | undefined, (userId: OwnerId) => string]
	>
}

function addOwner(
	owners: Map<string, DurableObjectOwner>,
	namespace: NamespaceLike | undefined,
	name: string,
	owner: DurableObjectOwner,
) {
	if (!namespace) return
	owners.set(namespace.idFromName(name).toString(), owner)
}

/**
 * Object id → owner for every per-user object this deployment can name:
 * user-named hubs/meters/logs, StorageRunner buckets and RepoSession
 * workspaces from `user_storage_buckets`, and package-app realtime sessions.
 */
export async function buildDurableObjectOwnerMap(
	env: DurableObjectDurationAttributionEnv,
): Promise<Map<string, DurableObjectOwner>> {
	const owners = new Map<string, DurableObjectOwner>()
	const [users, orgs, buckets, apps] = await Promise.all([
		runD1WithRetry(() =>
			env.APP_DB.prepare(
				`SELECT stable_user_id FROM users WHERE deleting_at IS NULL${andLiveDeletedAtSql()}`,
			).all<{ stable_user_id: OwnerId }>(),
		),
		runD1WithRetry(() =>
			env.APP_DB.prepare(
				`SELECT id FROM orgs WHERE deleting_at IS NULL${andLiveDeletedAtSql()}`,
			).all<{ id: OwnerId }>(),
		),
		runD1WithRetry(() =>
			env.APP_DB.prepare(
				`SELECT user_id, storage_id, kind FROM user_storage_buckets WHERE deleted_at IS NULL`,
			).all<{ user_id: OwnerId; storage_id: string; kind: string }>(),
		),
		runD1WithRetry(() =>
			env.APP_DB.prepare(
				`SELECT user_id, id FROM saved_packages WHERE has_app = 1${andLiveDeletedAtSql()}`,
			).all<{ user_id: OwnerId; id: string }>(),
		),
	])
	const namespaces = perUserNamespaces(env)
	const ownerIds = new Set<OwnerId>()
	for (const { stable_user_id: userId } of users.results ?? []) {
		ownerIds.add(userId)
	}
	// Team orgs have no users row. Personal orgs repeat stable_user_id.
	for (const { id } of orgs.results ?? []) ownerIds.add(id)
	for (const userId of ownerIds) {
		for (const [doClass, namespace, name] of namespaces) {
			addOwner(owners, namespace, name(userId), { userId, doClass })
		}
	}
	for (const bucket of buckets.results ?? []) {
		if (!ownerIds.has(bucket.user_id)) continue
		if (bucket.kind === 'repo_session') {
			const sessionId = readRepoSessionId(bucket.storage_id)
			if (sessionId) {
				addOwner(
					owners,
					env.REPO_SESSION,
					repoSessionDurableObjectName(sessionId),
					{ userId: bucket.user_id, doClass: 'RepoSession' },
				)
			}
			continue
		}
		addOwner(
			owners,
			env.STORAGE_RUNNER,
			storageRunnerDurableObjectName(bucket.user_id, bucket.storage_id),
			{ userId: bucket.user_id, doClass: 'StorageRunner' },
		)
	}
	for (const app of apps.results ?? []) {
		if (!ownerIds.has(app.user_id)) continue
		addOwner(
			owners,
			env.PACKAGE_REALTIME_SESSION,
			packageRealtimeSessionDurableObjectName({
				userId: app.user_id,
				packageId: app.id,
			}),
			{ userId: app.user_id, doClass: 'PackageRealtimeSession' },
		)
	}
	return owners
}

function readRepoSessionId(storageId: string): string | null {
	try {
		return repoSessionIdFromStorageBucketId(storageId)
	} catch {
		return null
	}
}

type PeriodicGroup = {
	dimensions: { objectId: string }
	sum: { activeTime: number }
}

export function buildDurableObjectActiveTimeQuery() {
	return `query DurableObjectActiveTime($accountTag: string!, $day: Date!, $limit: Int!) {
	viewer {
		accounts(filter: { accountTag: $accountTag }) {
			durableObjectsPeriodicGroups(
				limit: $limit
				filter: { date: $day }
				orderBy: [sum_activeTime_DESC]
			) {
				dimensions { objectId }
				sum { activeTime }
			}
			fleet: durableObjectsPeriodicGroups(limit: 1, filter: { date: $day }) {
				sum { activeTime }
			}
		}
	}
}`
}

async function queryDurableObjectActiveTime(input: {
	accountId: string
	apiToken: string
	baseUrl: string
	day: string
}): Promise<{
	groups: Array<PeriodicGroup>
	fleetActiveTimeUs: number | null
}> {
	const response = await fetch(
		`${input.baseUrl.replace(/\/$/, '')}/client/v4/graphql`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${input.apiToken}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				query: buildDurableObjectActiveTimeQuery(),
				variables: {
					accountTag: input.accountId,
					day: input.day,
					limit: durableObjectDurationAttributionObjectLimit,
				},
			}),
			signal: AbortSignal.timeout(graphqlTimeoutMs),
		},
	)
	const text = await response.text()
	if (!response.ok) {
		throw new Error(
			`Durable Object analytics query failed (${response.status}): ${text.slice(0, 300)}`,
		)
	}
	const body = JSON.parse(text) as {
		data?: {
			viewer?: {
				accounts?: Array<{
					durableObjectsPeriodicGroups?: Array<PeriodicGroup>
					fleet?: Array<{ sum?: { activeTime?: number } }>
				}>
			}
		}
		errors?: Array<{ message?: string }> | null
	}
	if (body.errors?.length) {
		throw new Error(
			`Durable Object analytics query failed: ${body.errors
				.map((error) => error.message ?? 'unknown error')
				.join('; ')
				.slice(0, 300)}`,
		)
	}
	const account = body.data?.viewer?.accounts?.[0]
	// A missing account means Cloudflare did not answer for this account tag,
	// not that nothing ran; treating it as zero would wipe the day's rows.
	if (!account) {
		throw new Error(
			'Durable Object analytics query returned no account for the configured account id',
		)
	}
	const fleetActiveTimeUs = Number(account.fleet?.[0]?.sum?.activeTime)
	return {
		groups: account.durableObjectsPeriodicGroups ?? [],
		fleetActiveTimeUs: Number.isFinite(fleetActiveTimeUs)
			? fleetActiveTimeUs
			: null,
	}
}

/** Cloudflare `activeTime` is microseconds; stored values are milliseconds. */
function activeTimeToMs(activeTimeUs: number): number {
	const value = Number(activeTimeUs)
	return Number.isFinite(value) && value > 0 ? Math.round(value / 1000) : 0
}

/**
 * `fleetActiveTimeUs` is the account-wide total for the day; when present it
 * replaces the per-object sum so a truncated object list does not shrink the
 * denominator and overstate the attributed share.
 */
export function attributeDurableObjectActiveTime(input: {
	groups: ReadonlyArray<PeriodicGroup>
	owners: ReadonlyMap<string, DurableObjectOwner>
	fleetActiveTimeUs?: number | null
}) {
	const byOwner = new Map<
		string,
		DurableObjectOwner & { activeMs: number; objectCount: number }
	>()
	let totalActiveMs = 0
	let attributedActiveMs = 0
	let attributedObjectCount = 0
	for (const group of input.groups) {
		const activeMs = activeTimeToMs(group.sum.activeTime)
		totalActiveMs += activeMs
		const owner = input.owners.get(group.dimensions.objectId)
		if (!owner) continue
		attributedActiveMs += activeMs
		attributedObjectCount += 1
		const key = `${owner.userId}\n${owner.doClass}`
		const existing = byOwner.get(key)
		if (existing) {
			existing.activeMs += activeMs
			existing.objectCount += 1
		} else {
			byOwner.set(key, { ...owner, activeMs, objectCount: 1 })
		}
	}
	if (input.fleetActiveTimeUs != null) {
		totalActiveMs = Math.max(
			totalActiveMs,
			activeTimeToMs(input.fleetActiveTimeUs),
		)
	}
	return {
		rows: [...byOwner.values()],
		totalActiveMs,
		attributedActiveMs,
		objectCount: input.groups.length,
		attributedObjectCount,
	}
}

/**
 * D1 caps a statement at 100 bound parameters. Upserts bind 4 per row plus
 * the shared day and timestamp; deletes bind 2 per row plus the day.
 */
export const durableObjectDurationUpsertRowsPerStatement = 24
export const durableObjectDurationDeleteRowsPerStatement = 49
/** Statements per D1 batch() call; each batch is its own transaction. */
export const durableObjectDurationStatementsPerBatch = 10
/** Gap between batches so one run never fills D1's 10-second window. */
export const durableObjectDurationWriteBatchPauseMs = 250

type DurationRow = DurableObjectOwner & {
	activeMs: number
	objectCount: number
}

function chunk<T>(items: ReadonlyArray<T>, size: number): Array<Array<T>> {
	const chunks: Array<Array<T>> = []
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size))
	}
	return chunks
}

function durationRowKey(userId: string, doClass: string) {
	return `${userId}\n${doClass}`
}

/**
 * Brings one day's stored rows in line with `rows` without rewriting the
 * whole day: unchanged rows are skipped, changed or new rows go out as
 * multi-row upserts, and rows no longer attributed are deleted. Writes go in
 * small paced batches (KODY-DS: the old one-statement-per-row rewrite issued
 * thousands of statements in one burst and overloaded D1). A failure midway
 * leaves some rows at the previous run's values, never missing; the next run
 * converges. Coverage is written last.
 */
export async function writeDurableObjectDurationDay(input: {
	db: D1Database
	day: string
	rows: ReadonlyArray<DurationRow>
	coverage: {
		totalActiveMs: number
		attributedActiveMs: number
		objectCount: number
		attributedObjectCount: number
		truncated: boolean
	}
	updatedAt: string
	pauseMs: number
}) {
	const { db, day, updatedAt } = input
	const existing = await runD1WithRetry(() =>
		db
			.prepare(
				`SELECT user_id, do_class, active_ms, object_count
				 FROM durable_object_duration_daily WHERE day = ?`,
			)
			.bind(day)
			.all<{
				user_id: string
				do_class: string
				active_ms: number
				object_count: number
			}>(),
	)
	const stored = new Map(
		(existing.results ?? []).map((row) => [
			durationRowKey(row.user_id, row.do_class),
			row,
		]),
	)
	const changed: Array<DurationRow> = []
	for (const row of input.rows) {
		const key = durationRowKey(row.userId, row.doClass)
		const previous = stored.get(key)
		stored.delete(key)
		if (
			previous &&
			Number(previous.active_ms) === row.activeMs &&
			Number(previous.object_count) === row.objectCount
		) {
			continue
		}
		changed.push(row)
	}
	const stale = [...stored.values()]
	const statements: Array<D1PreparedStatement> = []
	for (const rows of chunk(
		changed,
		durableObjectDurationUpsertRowsPerStatement,
	)) {
		const values = rows
			.map((_row, index) => {
				const base = 3 + index * 4
				return `(?${base}, ?${base + 1}, ?${base + 2}, ?${base + 3})`
			})
			.join(', ')
		// The owner map is a snapshot. Skip owners whose deletion or
		// soft-delete started since, including team orgs with no users row.
		statements.push(
			db
				.prepare(
					`INSERT INTO durable_object_duration_daily
						(user_id, do_class, day, active_ms, object_count, updated_at)
					 SELECT v.column1, v.column2, ?1, v.column3, v.column4, ?2
					 FROM (VALUES ${values}) AS v
					 WHERE ${liveBillingOwnerSql('v.column1')}
					 ON CONFLICT (user_id, do_class, day) DO UPDATE SET
						active_ms = excluded.active_ms,
						object_count = excluded.object_count,
						updated_at = excluded.updated_at`,
				)
				.bind(
					day,
					updatedAt,
					...rows.flatMap((row) => [
						row.userId,
						row.doClass,
						row.activeMs,
						row.objectCount,
					]),
				),
		)
	}
	for (const rows of chunk(
		stale,
		durableObjectDurationDeleteRowsPerStatement,
	)) {
		const pairs = rows
			.map((_row, index) => `(?${2 + index * 2}, ?${3 + index * 2})`)
			.join(', ')
		statements.push(
			db
				.prepare(
					`DELETE FROM durable_object_duration_daily
					 WHERE day = ?1 AND (user_id, do_class) IN (VALUES ${pairs})`,
				)
				.bind(day, ...rows.flatMap((row) => [row.user_id, row.do_class])),
		)
	}
	statements.push(
		db
			.prepare(
				`INSERT INTO durable_object_duration_coverage_daily (
					day, total_active_ms, attributed_active_ms, object_count,
					attributed_object_count, truncated, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (day) DO UPDATE SET
					total_active_ms = excluded.total_active_ms,
					attributed_active_ms = excluded.attributed_active_ms,
					object_count = excluded.object_count,
					attributed_object_count = excluded.attributed_object_count,
					truncated = excluded.truncated,
					updated_at = excluded.updated_at`,
			)
			.bind(
				day,
				input.coverage.totalActiveMs,
				input.coverage.attributedActiveMs,
				input.coverage.objectCount,
				input.coverage.attributedObjectCount,
				input.coverage.truncated ? 1 : 0,
				updatedAt,
			),
	)
	const batches = chunk(statements, durableObjectDurationStatementsPerBatch)
	for (const [index, batch] of batches.entries()) {
		if (index > 0 && input.pauseMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, input.pauseMs))
		}
		await runD1WithRetry(() => db.batch(batch))
	}
	return { changed: changed.length, deleted: stale.length }
}

/**
 * Refresh yesterday and today (UTC). Yesterday settles once Cloudflare's
 * analytics catch up; today is partial and is overwritten each hour.
 */
export async function runDurableObjectDurationAttribution(input: {
	env: DurableObjectDurationAttributionEnv
	now?: Date
	batchPauseMs?: number
}): Promise<DurableObjectDurationAttributionResult> {
	const accountId = input.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = input.env.CLOUDFLARE_API_TOKEN?.trim()
	if (!accountId || !apiToken) {
		console.debug(
			'durable-object-duration-attribution-skipped',
			'missing Cloudflare REST credentials',
		)
		return { status: 'skipped', reason: 'missing_credentials' }
	}
	const now = input.now ?? new Date()
	const baseUrl =
		input.env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com'
	const days = [
		utcDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
		utcDayKey(now),
	]
	const owners = await buildDurableObjectOwnerMap(input.env)
	const updatedAt = now.toISOString()
	const results = []
	for (const day of days) {
		const { groups, fleetActiveTimeUs } = await queryDurableObjectActiveTime({
			accountId,
			apiToken,
			baseUrl,
			day,
		})
		// No objects at all means analytics have not caught up yet (a fleet
		// with live users is never fully idle); keep the last good write.
		if (groups.length === 0) {
			results.push({
				day,
				totalActiveMs: 0,
				attributedActiveMs: 0,
				objectCount: 0,
				attributedObjectCount: 0,
				truncated: false,
				skipped: true,
			})
			continue
		}
		const attribution = attributeDurableObjectActiveTime({
			groups,
			owners,
			fleetActiveTimeUs,
		})
		const truncated =
			groups.length >= durableObjectDurationAttributionObjectLimit
		await writeDurableObjectDurationDay({
			db: input.env.APP_DB,
			day,
			rows: attribution.rows,
			coverage: {
				totalActiveMs: attribution.totalActiveMs,
				attributedActiveMs: attribution.attributedActiveMs,
				objectCount: attribution.objectCount,
				attributedObjectCount: attribution.attributedObjectCount,
				truncated,
			},
			updatedAt,
			pauseMs: input.batchPauseMs ?? durableObjectDurationWriteBatchPauseMs,
		})
		results.push({
			day,
			totalActiveMs: attribution.totalActiveMs,
			attributedActiveMs: attribution.attributedActiveMs,
			objectCount: attribution.objectCount,
			attributedObjectCount: attribution.attributedObjectCount,
			truncated,
			skipped: false,
		})
	}
	console.info('durable-object-duration-attribution', JSON.stringify(results))
	return { status: 'completed', days: results }
}
