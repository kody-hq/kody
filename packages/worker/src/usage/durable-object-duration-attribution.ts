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
 * Refresh yesterday and today (UTC). Yesterday settles once Cloudflare's
 * analytics catch up; today is partial and is overwritten each hour.
 */
export async function runDurableObjectDurationAttribution(input: {
	env: DurableObjectDurationAttributionEnv
	now?: Date
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
		const statements = [
			input.env.APP_DB.prepare(
				`DELETE FROM durable_object_duration_daily WHERE day = ?`,
			).bind(day),
			...attribution.rows.map((row) =>
				// The owner map is a snapshot. Skip owners whose deletion or
				// soft-delete started since, including team orgs with no users row.
				input.env.APP_DB.prepare(
					`INSERT INTO durable_object_duration_daily
						(user_id, do_class, day, active_ms, object_count, updated_at)
					 SELECT ?1, ?2, ?3, ?4, ?5, ?6
					 WHERE ${liveBillingOwnerSql('?1')}`,
				).bind(
					row.userId,
					row.doClass,
					day,
					row.activeMs,
					row.objectCount,
					updatedAt,
				),
			),
			input.env.APP_DB.prepare(
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
			).bind(
				day,
				attribution.totalActiveMs,
				attribution.attributedActiveMs,
				attribution.objectCount,
				attribution.attributedObjectCount,
				truncated ? 1 : 0,
				updatedAt,
			),
		]
		// One batch per day: D1 applies it atomically, so a day is never left
		// half-deleted.
		await runD1WithRetry(() => input.env.APP_DB.batch(statements))
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
