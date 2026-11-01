import { utcDayKey, utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { loadOrgUsageWarningsEnabled } from '#worker/orgs/usage-warnings.ts'
import { sendGatedTransactionalEmail } from '#worker/email/transactional-send-policy.ts'
import {
	buildUserEntitlementWarningEmail,
	type UserEntitlementWarningKind,
} from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { readAdminEntitlementConsumption } from '#worker/admin/entitlement-consumption.ts'
import { readMonthlyComputeUsage } from '#worker/billing/compute-overage-usage.ts'
import {
	accountCreditsPath,
	buildComputeOverageHowToReduce,
	computeOverageIncludePercent,
	computeOverageResourceVisibility,
	computeOverageUnitLabels,
	computeOverageWarningResourceLabels,
	customerFacingComputeOverageMeters,
	resolvePastIncludeStopLimits,
	type ComputeOverageWarningResource,
} from '#universal/compute-overage.ts'
import {
	planLimits,
	type EntitlementResource,
	type UserEntitlement,
} from '#universal/plans.ts'
import {
	resolveUserEntitlementFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import {
	joinOrgsOnPersonalOrgIdSql,
	personalOrgIdSql,
} from '#worker/orgs/personal-org-sql.ts'
import { observeOnlyUsageEventTypes } from '#universal/usage-event-types.ts'
import { computeIncludeWarningPutsAccessAtRisk } from '#universal/usage-presentation.ts'
import { sendToOrgBillingRecipients } from '#worker/billing/org-billing-emails.ts'

export { type UserEntitlementWarningKind }

const observeOnlyMetricPlaceholders = observeOnlyUsageEventTypes
	.map(() => '?')
	.join(', ')

/**
 * Hourly user-facing entitlement warnings. Shares the
 * `usage_entitlement_alert` lane with operator
 * `fleet.entitlement.crossed` events so both stay on the same UTC-hour
 * cadence. Failures here must not block the operator events.
 *
 * One email per crossing of 80% or 100% on a specific entitlement or
 * monthly Worker compute / Rows read include. Include crossings only mail
 * when they would stop runs (an empty purchasable-Pro wallet): Free and
 * other wallet-less plans are never charged or stopped by those meters, and
 * funded wallets get the low-balance / auto-refill cap mails instead.
 * Staying over the same
 * threshold does not mail again. A later drop below that threshold, then a
 * climb back over it, is a new instance. Same-hour crossings of the same
 * kind still batch into one mail. Stock claims expire after 30 days unless
 * an hourly sweep still sees the user over and refreshes the TTL; daily
 * `*_per_day` claims stay scoped to the UTC day. Compute includes use
 * month-qualified stock claims so a July crossing does not suppress August.
 * The call to action is `/account/credits` (add credits, or switch to Pro
 * first on Free and retired plans).
 *
 * The hosted execute cap does not wait for the sweep: the call that crosses
 * 80% or 100% of the daily limit mails through
 * {@link sendEntitlementWarningNow} on the same claims, and the sweep only
 * backstops a crossing that send missed.
 */

export const userEntitlementWarningKvKeyPrefix = 'entitlement-warning-user:v3'
export const userEntitlementWarningSweepLimit = 100
export const userEntitlementWarningActiveSweepLimit = 80
export const userEntitlementWarningStockSweepLimit = 40
export const userEntitlementWarningComputeSweepLimit = 40
export const userEntitlementApproachingThreshold = 0.8
export const userEntitlementReachedThreshold = 1
const warningSweepConcurrency = 4
const dailyClaimLookbackDays = 3
export const userEntitlementWarningDailyClaimTtlSeconds = 36 * 60 * 60
export const userEntitlementWarningStockClaimTtlSeconds = 30 * 24 * 60 * 60

const stockPackageThreshold = Math.ceil(planLimits.free.maxSavedPackages * 0.8)
const stockSecretThreshold = Math.ceil(planLimits.free.maxSecrets * 0.8)

type WarningCandidate = UserEntitlementRow & {
	stable_user_id: OwnerId
	/** Personal org id — owner key for usage, wallets, meters, billing mail. */
	org_id: OwnerId
	email: string
}

const candidateColumnsSql = `u.stable_user_id, o.id AS org_id, u.email, ${userEntitlementColumnsSql('o')}`
const orgEntitlementJoinSql = `${joinOrgsOnPersonalOrgIdSql}${andLiveDeletedAtSql('o')}`
/** Owner-keyed stock / rollup rows join to the effective personal org id. */
const joinUsersOnOwnerKeyedIdSql = `INNER JOIN users u ON ${personalOrgIdSql} =`

export type UserWarningResource =
	| EntitlementResource
	| ComputeOverageWarningResource

export type UserEntitlementWarning = {
	resource: UserWarningResource
	label: string
	current: number
	limit: number
	percentOfLimit: number
	whatCounts?: string
	howToReduce?: string
	/** Monthly include (not a hard cap); worded as include used, never >100%. */
	include?: { unitLabel: string }
}

export type UserEntitlementWarningEmailResult =
	| { status: 'skipped'; reason: 'no_kv' | 'no_email_config' }
	| { status: 'no_warnings' }
	| {
			status: 'notified'
			emailedUsers: number
			emailsSent: number
			warnedResources: number
	  }

export function isDailyEntitlementResource(resource: UserWarningResource) {
	return resource.endsWith('_per_day')
}

export function isMonthlyComputeWarningResource(
	resource: UserWarningResource,
): resource is ComputeOverageWarningResource {
	return (
		resource === 'unique_worker_days' || resource === 'durable_object_rows_read'
	)
}

export function userEntitlementWarningKvKey(input: {
	userId: string
	kind: UserEntitlementWarningKind
	resource: UserWarningResource
	day?: string
	month?: string
}) {
	const base = `${userEntitlementWarningKvKeyPrefix}:${input.userId}:${input.kind}:${input.resource}`
	if (isDailyEntitlementResource(input.resource)) {
		if (!input.day) {
			throw new Error(
				`Daily entitlement warning key for ${input.resource} requires a UTC day`,
			)
		}
		return `${base}:${input.day}`
	}
	if (isMonthlyComputeWarningResource(input.resource)) {
		if (!input.month) {
			throw new Error(
				`Compute entitlement warning key for ${input.resource} requires a UTC month`,
			)
		}
		return `${base}:${input.month}`
	}
	return base
}

export async function sendUserEntitlementWarningEmails(input: {
	env: Env
	now?: Date
}): Promise<UserEntitlementWarningEmailResult> {
	const now = input.now ?? new Date()
	if (!input.env.BUNDLE_ARTIFACTS_KV) {
		return { status: 'skipped', reason: 'no_kv' }
	}
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	if (!emailConfig) {
		return { status: 'skipped', reason: 'no_email_config' }
	}

	const candidates = await listUsersForEntitlementWarningSweep(
		input.env.APP_DB,
		now,
	)
	if (candidates.length === 0) return { status: 'no_warnings' }

	let emailedUsers = 0
	let emailsSent = 0
	let warnedResources = 0
	await mapWithConcurrency(
		candidates,
		warningSweepConcurrency,
		async (user) => {
			const sent = await warnOneUserIfNeeded({
				env: input.env,
				emailConfig,
				user,
				now,
			})
			if (!sent) return
			emailedUsers += 1
			emailsSent += sent.emailsSent
			warnedResources += sent.warnedResources
		},
	)

	if (emailedUsers === 0) return { status: 'no_warnings' }
	console.info('user-entitlement-warning-emailed', {
		emailedUsers,
		emailsSent,
		warnedResources,
	})
	return { status: 'notified', emailedUsers, emailsSent, warnedResources }
}

async function warnOneUserIfNeeded(input: {
	env: Env
	emailConfig: { appBaseUrl: string; fromEmail: string }
	user: WarningCandidate
	now: Date
}): Promise<{ emailsSent: number; warnedResources: number } | null> {
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) return null

	const ownerId = input.user.org_id
	const entitlement = await resolveUserEntitlementFromRow({
		db: input.env.APP_DB,
		stableUserId: ownerId,
		row: input.user,
		now: input.now,
	})
	const [consumption, computeWarnings] = await Promise.all([
		readAdminEntitlementConsumption({
			env: input.env,
			usageUserId: ownerId,
			entitlement,
			now: input.now,
		}),
		readComputeOverageWarnings({
			db: input.env.APP_DB,
			stableUserId: ownerId,
			entitlement,
			now: input.now,
		}),
	])
	const approaching: Array<UserEntitlementWarning> = []
	const reached: Array<UserEntitlementWarning> = []
	for (const item of [...consumption, ...computeWarnings]) {
		if (item.percentOfLimit == null) continue
		const warning = {
			resource: item.resource,
			label: item.label,
			current: item.current,
			limit: item.limit,
			percentOfLimit: item.percentOfLimit,
			...('whatCounts' in item && item.whatCounts
				? { whatCounts: item.whatCounts }
				: {}),
			...('howToReduce' in item && item.howToReduce
				? { howToReduce: item.howToReduce }
				: {}),
			...('include' in item && item.include ? { include: item.include } : {}),
		}
		if (item.percentOfLimit >= userEntitlementReachedThreshold) {
			reached.push(warning)
			continue
		}
		if (item.percentOfLimit >= userEntitlementApproachingThreshold) {
			approaching.push(warning)
			await deleteWarningClaims({
				kv,
				userId: ownerId,
				kind: 'reached',
				resource: item.resource,
				now: input.now,
			})
			continue
		}
		await Promise.all([
			deleteWarningClaims({
				kv,
				userId: ownerId,
				kind: 'approaching',
				resource: item.resource,
				now: input.now,
			}),
			deleteWarningClaims({
				kv,
				userId: ownerId,
				kind: 'reached',
				resource: item.resource,
				now: input.now,
			}),
		])
	}

	const newReached = await unclaimedWarnings({
		kv,
		userId: ownerId,
		kind: 'reached',
		warnings: reached,
		now: input.now,
	})
	const newApproaching = await unclaimedWarnings({
		kv,
		userId: ownerId,
		kind: 'approaching',
		warnings: approaching,
		now: input.now,
	})
	await refreshStillOverStockClaims({
		kv,
		userId: ownerId,
		now: input.now,
		reached,
		approaching,
		newReached,
		newApproaching,
	})
	if (newApproaching.length === 0 && newReached.length === 0) return null

	let emailsSent = 0
	let warnedResources = 0
	// Reached first so a same-hour jump to 100% sends the limit mail
	// even when an 80% send is also due.
	for (const [kind, warnings] of [
		['reached', newReached],
		['approaching', newApproaching],
	] as const) {
		const sent = await sendThresholdEmailIfNeeded({
			env: input.env,
			kv,
			emailConfig: input.emailConfig,
			ownerId,
			kind,
			warnings,
			now: input.now,
		})
		if (!sent) continue
		emailsSent += 1
		warnedResources += warnings.length
	}
	if (emailsSent === 0) return null
	return { emailsSent, warnedResources }
}

/**
 * Mail one entitlement crossing the moment a counted call crosses it rather
 * than on the next hourly sweep. Shares the sweep's per-window instance
 * claims, so whichever side sends first wins and the other skips.
 */
export async function sendEntitlementWarningNow(input: {
	env: Env
	ownerId: OwnerId
	kind: UserEntitlementWarningKind
	warning: UserEntitlementWarning
	now?: Date
}): Promise<boolean> {
	const now = input.now ?? new Date()
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) return false
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	if (!emailConfig) return false
	const pending = await unclaimedWarnings({
		kv,
		userId: input.ownerId,
		kind: input.kind,
		warnings: [input.warning],
		now,
	})
	if (pending.length === 0) return false
	return await sendThresholdEmailIfNeeded({
		env: input.env,
		kv,
		emailConfig,
		ownerId: input.ownerId,
		kind: input.kind,
		warnings: pending,
		now,
	})
}

async function sendThresholdEmailIfNeeded(input: {
	env: Env
	kv: KVNamespace
	emailConfig: { appBaseUrl: string; fromEmail: string }
	ownerId: string
	kind: UserEntitlementWarningKind
	warnings: Array<UserEntitlementWarning>
	now: Date
}): Promise<boolean> {
	if (input.warnings.length === 0) return false
	if (!(await loadOrgUsageWarningsEnabled(input.env.APP_DB, input.ownerId))) {
		return false
	}

	const creditsUrl = new URL(
		accountCreditsPath,
		input.emailConfig.appBaseUrl,
	).toString()
	const usageUrl = new URL(
		'/account/usage',
		input.emailConfig.appBaseUrl,
	).toString()
	const email = buildUserEntitlementWarningEmail({
		appBaseUrl: input.emailConfig.appBaseUrl,
		creditsUrl,
		usageUrl,
		kind: input.kind,
		warnings: input.warnings,
	})

	let anySent = false
	try {
		await sendToOrgBillingRecipients({
			db: input.env.APP_DB,
			orgId: input.ownerId,
			sendOne: async (recipient) => {
				let sendResult: Awaited<ReturnType<typeof sendGatedTransactionalEmail>>
				try {
					sendResult = await sendGatedTransactionalEmail({
						db: input.env.APP_DB,
						config: {
							accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
							apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
							apiToken: input.env.CLOUDFLARE_API_TOKEN,
						},
						category: 'holdable',
						kind: 'entitlement_warning',
						message: {
							to: recipient.email,
							from: input.emailConfig.fromEmail,
							subject: email.subject,
							html: email.html,
							text: email.text,
						},
					})
				} catch (error) {
					console.warn('user-entitlement-warning-send-failed', error)
					return
				}
				if (!sendResult.ok) {
					console.warn('user-entitlement-warning-send-skipped', {
						reason: sendResult.error ?? 'unconfigured',
					})
					return
				}
				anySent = true
			},
		})
	} catch (error) {
		console.warn('user-entitlement-warning-recipients-failed', error)
		return false
	}
	if (!anySent) return false

	await claimWarningInstance({
		kv: input.kv,
		userId: input.ownerId,
		kind: input.kind,
		warnings: input.warnings,
		now: input.now,
	})
	return true
}

async function unclaimedWarnings(input: {
	kv: KVNamespace
	userId: string
	kind: UserEntitlementWarningKind
	warnings: Array<UserEntitlementWarning>
	now: Date
}) {
	const next: Array<UserEntitlementWarning> = []
	for (const warning of input.warnings) {
		const claimed = await input.kv.get(
			warningInstanceKey({
				userId: input.userId,
				kind: input.kind,
				resource: warning.resource,
				now: input.now,
			}),
		)
		if (claimed) continue
		next.push(warning)
	}
	return next
}

async function claimWarningInstance(input: {
	kv: KVNamespace
	userId: string
	kind: UserEntitlementWarningKind
	warnings: Array<UserEntitlementWarning>
	now: Date
}) {
	const claimedAt = String(input.now.getTime())
	for (const warning of input.warnings) {
		await putWarningClaim({
			kv: input.kv,
			userId: input.userId,
			kind: input.kind,
			resource: warning.resource,
			now: input.now,
			claimedAt,
		})
		if (input.kind !== 'reached') continue
		// Same climb already passed 80%. Claiming approaching here keeps a
		// later drop into the 80–99% band from sending a second mail.
		await putWarningClaim({
			kv: input.kv,
			userId: input.userId,
			kind: 'approaching',
			resource: warning.resource,
			now: input.now,
			claimedAt,
		})
	}
}

async function refreshStillOverStockClaims(input: {
	kv: KVNamespace
	userId: string
	now: Date
	reached: Array<UserEntitlementWarning>
	approaching: Array<UserEntitlementWarning>
	newReached: Array<UserEntitlementWarning>
	newApproaching: Array<UserEntitlementWarning>
}) {
	const claimedAt = String(input.now.getTime())
	const newReachedResources = new Set(
		input.newReached.map((warning) => warning.resource),
	)
	const newApproachingResources = new Set(
		input.newApproaching.map((warning) => warning.resource),
	)
	for (const warning of input.reached) {
		if (isDailyEntitlementResource(warning.resource)) continue
		if (newReachedResources.has(warning.resource)) continue
		await putWarningClaim({
			kv: input.kv,
			userId: input.userId,
			kind: 'reached',
			resource: warning.resource,
			now: input.now,
			claimedAt,
		})
		// Keep the paired approaching claim alive so sitting at a cap does
		// not let the 80% claim expire and rematch on a later drop to 80–99%.
		if (newApproachingResources.has(warning.resource)) continue
		await putWarningClaim({
			kv: input.kv,
			userId: input.userId,
			kind: 'approaching',
			resource: warning.resource,
			now: input.now,
			claimedAt,
		})
	}
	for (const warning of input.approaching) {
		if (isDailyEntitlementResource(warning.resource)) continue
		if (newApproachingResources.has(warning.resource)) continue
		await putWarningClaim({
			kv: input.kv,
			userId: input.userId,
			kind: 'approaching',
			resource: warning.resource,
			now: input.now,
			claimedAt,
		})
	}
}

function warningInstanceKey(input: {
	userId: string
	kind: UserEntitlementWarningKind
	resource: UserWarningResource
	now: Date
}) {
	return userEntitlementWarningKvKey({
		userId: input.userId,
		kind: input.kind,
		resource: input.resource,
		day: isDailyEntitlementResource(input.resource)
			? utcDayKey(input.now)
			: undefined,
		month: isMonthlyComputeWarningResource(input.resource)
			? utcMonthKey(input.now)
			: undefined,
	})
}

async function putWarningClaim(input: {
	kv: KVNamespace
	userId: string
	kind: UserEntitlementWarningKind
	resource: UserWarningResource
	now: Date
	claimedAt: string
}) {
	const key = warningInstanceKey(input)
	const expirationTtl = isDailyEntitlementResource(input.resource)
		? userEntitlementWarningDailyClaimTtlSeconds
		: userEntitlementWarningStockClaimTtlSeconds
	try {
		await input.kv.put(key, input.claimedAt, { expirationTtl })
	} catch (error) {
		console.warn('user-entitlement-warning-claim-failed', {
			kind: input.kind,
			resource: input.resource,
			error,
		})
	}
}

async function deleteWarningClaims(input: {
	kv: KVNamespace
	userId: string
	kind: UserEntitlementWarningKind
	resource: UserWarningResource
	now: Date
}) {
	if (isMonthlyComputeWarningResource(input.resource)) {
		await input.kv.delete(warningInstanceKey(input))
		return
	}
	if (!isDailyEntitlementResource(input.resource)) {
		await input.kv.delete(
			userEntitlementWarningKvKey({
				userId: input.userId,
				kind: input.kind,
				resource: input.resource,
			}),
		)
		return
	}
	await Promise.all(
		recentUtcDayKeys(input.now).map((day) =>
			input.kv.delete(
				userEntitlementWarningKvKey({
					userId: input.userId,
					kind: input.kind,
					resource: input.resource,
					day,
				}),
			),
		),
	)
}

function recentUtcDayKeys(now: Date) {
	const keys: Array<string> = []
	for (let daysAgo = 0; daysAgo < dailyClaimLookbackDays; daysAgo += 1) {
		keys.push(
			utcDayKey(new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000)),
		)
	}
	return keys
}

async function readComputeOverageWarnings(input: {
	db: D1Database
	stableUserId: string
	entitlement: UserEntitlement
	now: Date
}): Promise<Array<UserEntitlementWarning>> {
	if (!computeIncludeWarningPutsAccessAtRisk(input.entitlement.creditWallet)) {
		return []
	}
	const usage = await readMonthlyComputeUsage({
		db: input.db,
		stableUserId: input.stableUserId,
		month: utcMonthKey(input.now),
	})
	const currentByResource = {
		unique_worker_days: usage.uniqueWorkerDays,
		durable_object_rows_read: usage.durableObjectRowsRead,
	} as const satisfies Record<ComputeOverageWarningResource, number>
	const includeByResource = resolvePastIncludeStopLimits({
		...input.entitlement,
		now: input.now,
	})
	return customerFacingComputeOverageMeters.map((resource) => {
		const current = currentByResource[resource]
		const limit = includeByResource[resource]
		const percentOfLimit = computeOverageIncludePercent(current, limit) ?? 0
		return {
			resource,
			label: computeOverageWarningResourceLabels[resource],
			current,
			limit,
			percentOfLimit,
			whatCounts: computeOverageResourceVisibility[resource].whatCounts,
			include: { unitLabel: computeOverageUnitLabels[resource] },
			howToReduce: buildComputeOverageHowToReduce(
				resource,
				input.entitlement.plan,
				input.entitlement.creditWallet,
			),
		}
	})
}

export async function listUsersForEntitlementWarningSweep(
	db: D1Database,
	now: Date,
) {
	const currentMonth = utcMonthKey(now)
	const [active, packages, secrets, computeWorker, computeDorows] =
		await Promise.all([
			db
				.prepare(
					`SELECT ${candidateColumnsSql}
				 FROM (
					SELECT user_id, SUM(event_count) AS event_count
					FROM usage_rollups
					WHERE month = ?
						AND metric NOT IN (${observeOnlyMetricPlaceholders})
					GROUP BY user_id
					ORDER BY event_count DESC
					LIMIT ?
				 ) AS ranked
				 ${joinUsersOnOwnerKeyedIdSql} ranked.user_id
				 ${orgEntitlementJoinSql}
				 WHERE u.deleting_at IS NULL${andLiveDeletedAtSql('u')}
					AND u.email_verified_at IS NOT NULL
				 ORDER BY ranked.event_count DESC`,
				)
				.bind(
					currentMonth,
					...observeOnlyUsageEventTypes,
					userEntitlementWarningActiveSweepLimit,
				)
				.all<WarningCandidate>(),
			db
				.prepare(
					`SELECT ${candidateColumnsSql}
				 FROM (
					SELECT user_id, COUNT(*) AS stock_count
					FROM saved_packages
					WHERE deleted_at IS NULL
					GROUP BY user_id
					HAVING COUNT(*) >= ?
					ORDER BY stock_count DESC
					LIMIT ?
				 ) AS stock
				 ${joinUsersOnOwnerKeyedIdSql} stock.user_id
				 ${orgEntitlementJoinSql}
				 WHERE u.deleting_at IS NULL${andLiveDeletedAtSql('u')}
					AND u.email_verified_at IS NOT NULL`,
				)
				.bind(stockPackageThreshold, userEntitlementWarningStockSweepLimit)
				.all<WarningCandidate>(),
			db
				.prepare(
					`SELECT ${candidateColumnsSql}
				 FROM (
					SELECT sb.user_id, COUNT(*) AS stock_count
					FROM secret_entries se
					JOIN secret_buckets sb ON sb.id = se.bucket_id
					WHERE (sb.expires_at IS NULL OR sb.expires_at > ?)
						AND se.deleted_at IS NULL
						AND sb.deleted_at IS NULL
					GROUP BY sb.user_id
					HAVING COUNT(*) >= ?
					ORDER BY stock_count DESC
					LIMIT ?
				 ) AS stock
				 ${joinUsersOnOwnerKeyedIdSql} stock.user_id
				 ${orgEntitlementJoinSql}
				 WHERE u.deleting_at IS NULL${andLiveDeletedAtSql('u')}
					AND u.email_verified_at IS NOT NULL`,
				)
				.bind(
					now.toISOString(),
					stockSecretThreshold,
					userEntitlementWarningStockSweepLimit,
				)
				.all<WarningCandidate>(),
			db
				.prepare(
					`SELECT ${candidateColumnsSql}
				 FROM (
					SELECT user_id, event_count
					FROM usage_rollups
					WHERE month = ?
						AND metric = 'dynamic_worker_day'
					ORDER BY event_count DESC
					LIMIT ?
				 ) AS ranked
				 ${joinUsersOnOwnerKeyedIdSql} ranked.user_id
				 ${orgEntitlementJoinSql}
				 WHERE u.deleting_at IS NULL${andLiveDeletedAtSql('u')}
					AND u.email_verified_at IS NOT NULL
				 ORDER BY ranked.event_count DESC`,
				)
				.bind(currentMonth, userEntitlementWarningComputeSweepLimit)
				.all<WarningCandidate>(),
			db
				.prepare(
					`SELECT ${candidateColumnsSql}
				 FROM (
					SELECT user_id, event_count
					FROM usage_rollups
					WHERE month = ?
						AND metric = 'durable_object_rows_read'
					ORDER BY event_count DESC
					LIMIT ?
				 ) AS ranked
				 ${joinUsersOnOwnerKeyedIdSql} ranked.user_id
				 ${orgEntitlementJoinSql}
				 WHERE u.deleting_at IS NULL${andLiveDeletedAtSql('u')}
					AND u.email_verified_at IS NOT NULL
				 ORDER BY ranked.event_count DESC`,
				)
				.bind(currentMonth, userEntitlementWarningComputeSweepLimit)
				.all<WarningCandidate>(),
		])

	const byUserId = new Map<string, WarningCandidate>()
	for (const row of [
		...(computeWorker.results ?? []),
		...(computeDorows.results ?? []),
		...(active.results ?? []),
		...(packages.results ?? []),
		...(secrets.results ?? []),
	]) {
		if (byUserId.has(row.stable_user_id)) continue
		byUserId.set(row.stable_user_id, row)
		if (byUserId.size >= userEntitlementWarningSweepLimit) break
	}
	return [...byUserId.values()]
}

async function mapWithConcurrency<T>(
	items: ReadonlyArray<T>,
	concurrency: number,
	mapper: (item: T) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return
	const limit = Math.max(1, Math.min(concurrency, items.length))
	let nextIndex = 0
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex
				nextIndex += 1
				const item = items[index]
				if (item === undefined) return
				await mapper(item)
			}
		}),
	)
}
