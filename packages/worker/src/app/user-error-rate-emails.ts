import { redactKodyCredentials } from '@kody-internal/shared/api-token-format.ts'
import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	buildUserErrorRateEmail,
	type UserErrorRateEmailRun,
} from '#app/email/messages.ts'
import { sendGatedTransactionalEmail } from '#worker/email/transactional-send-policy.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { routes } from '#universal/routes.ts'
import { observeOnlyUsageEventTypes } from '#universal/usage-event-types.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'
import { listRunRecords } from '#worker/run-records/service.ts'
import type { RunRecord } from '#worker/run-records/types.ts'
import { personalOrgIdSql } from '#worker/orgs/personal-org-sql.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

const observeOnlyMetricPlaceholders = observeOnlyUsageEventTypes
	.map(() => '?')
	.join(', ')

export const userErrorRateEmailKvKeyPrefix = 'error-rate-email-user:v1'
export const userErrorRateEmailSweepLimit = 80
export const userErrorRateEmailClaimTtlSeconds = 40 * 24 * 60 * 60
export const userErrorRateMinErrors = 5
export const userErrorRateMinPercent = 0.2
export const userErrorRateAbsoluteErrors = 10
export const userErrorRateEmailMaxRuns = 3
const userErrorRateEmailRunScanLimit = 50
const userErrorRateEmailErrorMaxLength = 240

export function userErrorRateEmailKvKey(input: {
	userId: string
	month: string
}) {
	return `${userErrorRateEmailKvKeyPrefix}:${input.userId}:${input.month}`
}

export function shouldSendUserErrorRateEmail(input: {
	errorCount: number
	eventCount: number
}) {
	if (input.errorCount >= userErrorRateAbsoluteErrors) return true
	if (input.errorCount < userErrorRateMinErrors) return false
	if (input.eventCount <= 0) return false
	return input.errorCount / input.eventCount >= userErrorRateMinPercent
}

type ErrorRateCandidate = {
	stable_user_id: string
	/** Personal org id — owner key for usage rollups and run records. */
	org_id: string
	email: string
	event_count: number
	error_count: number
}

export type UserErrorRateEmailResult =
	| { status: 'skipped'; reason: 'no_kv' | 'no_email_config' }
	| { status: 'no_warnings' }
	| { status: 'notified'; emailedUsers: number }

export async function sendUserErrorRateEmails(input: {
	env: Env
	now?: Date
}): Promise<UserErrorRateEmailResult> {
	const now = input.now ?? new Date()
	if (!input.env.BUNDLE_ARTIFACTS_KV) {
		return { status: 'skipped', reason: 'no_kv' }
	}
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	if (!emailConfig) {
		return { status: 'skipped', reason: 'no_email_config' }
	}

	const month = utcMonthKey(now)
	const candidates = await input.env.APP_DB.prepare(
		`SELECT u.stable_user_id, ${personalOrgIdSql} AS org_id, u.email,
		        SUM(r.event_count) AS event_count,
		        SUM(r.error_count) AS error_count
		 FROM usage_rollups r
		 INNER JOIN users u ON ${personalOrgIdSql} = r.user_id
		 WHERE r.month = ?
		   AND r.metric NOT IN (${observeOnlyMetricPlaceholders})
		   AND u.deleting_at IS NULL${andLiveDeletedAtSql('u')}
		   AND u.email_verified_at IS NOT NULL
		 GROUP BY u.stable_user_id, ${personalOrgIdSql}
		 HAVING SUM(r.error_count) >= ?
		 ORDER BY SUM(r.error_count) DESC
		 LIMIT ?`,
	)
		.bind(
			month,
			...observeOnlyUsageEventTypes,
			userErrorRateMinErrors,
			userErrorRateEmailSweepLimit,
		)
		.all<ErrorRateCandidate>()

	const rows = candidates.results ?? []
	let emailedUsers = 0
	for (const user of rows) {
		if (
			!shouldSendUserErrorRateEmail({
				errorCount: Number(user.error_count),
				eventCount: Number(user.event_count),
			})
		) {
			continue
		}
		const sent = await sendOneUserErrorRateEmail({
			env: input.env,
			emailConfig,
			user: {
				...user,
				event_count: Number(user.event_count),
				error_count: Number(user.error_count),
			},
			month,
		})
		if (sent) emailedUsers += 1
	}

	if (emailedUsers === 0) return { status: 'no_warnings' }
	console.info('user-error-rate-emailed', { emailedUsers, month })
	return { status: 'notified', emailedUsers }
}

/**
 * Most recent open error per package (or per run name when the run has no
 * package), so the email names what is failing instead of only a count. A
 * lookup failure degrades to the count-only email rather than skipping it.
 */
async function loadFailingRuns(input: {
	env: Env
	appBaseUrl: string
	userId: string
	month: string
}): Promise<Array<UserErrorRateEmailRun>> {
	let runs: Array<RunRecord>
	try {
		const page = await listRunRecords({
			env: input.env,
			userId: ownerIdFromStored(input.userId),
			filter: {
				status: 'error',
				since: `${input.month}-01T00:00:00.000Z`,
				errorTriage: 'open',
			},
			limit: userErrorRateEmailRunScanLimit,
		})
		runs = page.runs
	} catch (error) {
		console.warn('user-error-rate-email-runs-failed', error)
		return []
	}

	const seen = new Set<string>()
	const picked: Array<RunRecord> = []
	for (const run of runs) {
		const key = run.packageId ? `package:${run.packageId}` : `name:${run.name}`
		if (seen.has(key)) continue
		seen.add(key)
		picked.push(run)
		if (picked.length >= userErrorRateEmailMaxRuns) break
	}

	return await Promise.all(
		picked.map(async (run) => ({
			label: await failingRunLabel({ env: input.env, run }),
			error: summarizeRunError(run),
			runUrl: new URL(
				`/account/activity/${encodeURIComponent(run.id)}`,
				input.appBaseUrl,
			).toString(),
		})),
	)
}

async function failingRunLabel(input: { env: Env; run: RunRecord }) {
	if (input.run.packageId) {
		try {
			const saved = await getSavedPackageByIdInAnyOrg(
				input.env.APP_DB,
				input.run.packageId,
			)
			if (saved) return `Package ${saved.name}`
		} catch (error) {
			console.warn('user-error-rate-email-package-lookup-failed', error)
		}
	}
	return input.run.name?.trim() || 'A run'
}

/**
 * Run errors are already scrubbed of substituted secret values when recorded;
 * Kody API tokens and bootstrap codes are redacted again because this text
 * leaves the run log for a mailbox.
 */
export function summarizeRunError(run: Pick<RunRecord, 'errorMessage'>) {
	const firstLine = redactKodyCredentials(
		run.errorMessage
			?.split('\n')
			.find((line) => line.trim())
			?.trim() ?? '',
	)
	if (!firstLine) return 'No error message was recorded.'
	if (firstLine.length <= userErrorRateEmailErrorMaxLength) return firstLine
	return `${firstLine.slice(0, userErrorRateEmailErrorMaxLength - 1).trimEnd()}…`
}

async function sendOneUserErrorRateEmail(input: {
	env: Env
	emailConfig: { appBaseUrl: string; fromEmail: string }
	user: ErrorRateCandidate
	month: string
}): Promise<boolean> {
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!kv) return false
	const key = userErrorRateEmailKvKey({
		userId: input.user.stable_user_id,
		month: input.month,
	})
	if (await kv.get(key)) return false

	const activityUrl = new URL(
		'/account/activity',
		input.emailConfig.appBaseUrl,
	).toString()
	const supportUrl = new URL(
		routes.support.href(),
		input.emailConfig.appBaseUrl,
	).toString()
	const email = buildUserErrorRateEmail({
		appBaseUrl: input.emailConfig.appBaseUrl,
		activityUrl,
		supportUrl,
		errorCount: input.user.error_count,
		eventCount: input.user.event_count,
		failingRuns: await loadFailingRuns({
			env: input.env,
			appBaseUrl: input.emailConfig.appBaseUrl,
			userId: input.user.org_id,
			month: input.month,
		}),
	})

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
			kind: 'error_rate',
			message: {
				to: input.user.email,
				from: input.emailConfig.fromEmail,
				subject: email.subject,
				html: email.html,
				text: email.text,
			},
		})
	} catch (error) {
		console.warn('user-error-rate-email-send-failed', error)
		return false
	}
	if (!sendResult.ok) {
		console.warn('user-error-rate-email-send-skipped', {
			reason: sendResult.error ?? 'unconfigured',
		})
		return false
	}

	try {
		await kv.put(key, String(Date.now()), {
			expirationTtl: userErrorRateEmailClaimTtlSeconds,
		})
	} catch (error) {
		console.warn('user-error-rate-email-claim-failed', error)
	}
	return true
}
