import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { renderTransactionalEmail } from '#app/email/template.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	getPackageCodemodRunById,
	listPackageCodemodRunItems,
	type PackageCodemodRunItemRecord,
} from './ledger.ts'

/**
 * Owner notice before a breaking gateway or credential rule change: email the
 * owners of every package a codemod scan flagged, once per notice and
 * recipient, naming each affected package, what breaks, and how to fix it.
 */

export const packageOwnerNoticeKvKeyPrefix = 'package-owner-notice:v1'
export const packageOwnerNoticeClaimTtlSeconds = 180 * 24 * 60 * 60
export const packageOwnerNoticeDefaultLimit = 20
export const packageOwnerNoticeMaxLimit = 50
export const packageOwnerNoticeIdPattern = /^[a-z0-9][a-z0-9-]{2,79}$/
/** Ledger rows read per notice step; a fleet scan is far below this. */
const maxRunItemsRead = 10_000
const runItemsPageSize = 200
const maxPackagesListed = 25

export function packageOwnerNoticeKvKey(input: {
	noticeId: string
	ownerId: string
	recipientUserId: string
}) {
	return `${packageOwnerNoticeKvKeyPrefix}:${input.noticeId}:${input.ownerId}:${input.recipientUserId}`
}

export type PackageOwnerNoticeStatus =
	| 'would_send'
	| 'sent'
	| 'already_sent'
	| 'no_recipients'
	| 'send_failed'
	/** Delivered, but a claim write failed, so a re-run may email again. */
	| 'claim_failed'

export type PackageOwnerNoticePackage = {
	packageId: string
	kodyId: string
	findings: Array<string>
}

export type PackageOwnerNoticeOwner = {
	ownerId: string
	status: PackageOwnerNoticeStatus
	recipientCount: number
	packages: Array<PackageOwnerNoticePackage>
}

export type PackageOwnerNoticeResult = {
	runId: string
	codemodId: string
	noticeId: string
	dryRun: boolean
	owners: Array<PackageOwnerNoticeOwner>
	summary: Partial<Record<PackageOwnerNoticeStatus, number>>
	/** Rendered email for the first owner on this page (dry run only). */
	preview: { subject: string; text: string } | null
	nextCursor: string | null
}

export type PackageOwnerNoticeContent = {
	subject: string
	/** What stops working, and for which requests. */
	whatBreaks: string
	/** The change the owner makes to their package. */
	howToFix: string
	/** When the rule starts being enforced, in words (for example "June 1, 2027"). */
	effectiveAt: string
}

export class PackageOwnerNoticeError extends Error {}

type Recipient = { userId: string; email: string }

/**
 * Owners of the owning org with a verified address. A personal org has no
 * membership rows, so its owner is the user whose stable id is the org id.
 */
async function loadOwnerRecipients(
	db: D1Database,
	ownerId: string,
): Promise<Array<Recipient>> {
	const { results: memberships } = await db
		.prepare(
			`SELECT user_id
			 FROM org_memberships
			 WHERE org_id = ?
			   AND role = 'owner'
			   AND deleted_at IS NULL`,
		)
		.bind(ownerId)
		.all<{ user_id: string }>()
	const userIds =
		memberships.length > 0 ? memberships.map((row) => row.user_id) : [ownerId]
	const placeholders = userIds.map(() => '?').join(', ')
	const { results } = await db
		.prepare(
			`SELECT stable_user_id AS user_id, email
			 FROM users
			 WHERE stable_user_id IN (${placeholders})
			   AND deleting_at IS NULL
			   AND email_verified_at IS NOT NULL
			   AND email IS NOT NULL
			   AND TRIM(email) != ''${andLiveDeletedAtSql()}`,
		)
		.bind(...userIds)
		.all<{ user_id: string; email: string }>()
	return results.map((row) => ({
		userId: row.user_id,
		email: row.email.trim(),
	}))
}

async function loadFlaggedPackagesByOwner(input: {
	db: D1Database
	runId: string
	findingMessages: ReadonlySet<string> | null
}) {
	const byOwner = new Map<string, Array<PackageOwnerNoticePackage>>()
	let afterId: string | null = null
	let read = 0
	while (read <= maxRunItemsRead) {
		const items: Array<PackageCodemodRunItemRecord> =
			await listPackageCodemodRunItems(input.db, {
				runId: input.runId,
				afterId,
				limit: runItemsPageSize,
			})
		if (items.length === 0) break
		read += items.length
		afterId = items.at(-1)!.id
		for (const item of items) {
			const findings = item.findings
				.map((finding) => finding.message)
				.filter(
					(message) =>
						input.findingMessages == null || input.findingMessages.has(message),
				)
			if (findings.length === 0) continue
			const packages = byOwner.get(item.userId) ?? []
			packages.push({
				packageId: item.packageId,
				kodyId: item.kodyId,
				findings: [...new Set(findings)],
			})
			byOwner.set(item.userId, packages)
		}
		if (items.length < runItemsPageSize) break
	}
	if (read > maxRunItemsRead) {
		throw new PackageOwnerNoticeError(
			`Run has more than ${maxRunItemsRead} items; filter the scan before sending a notice.`,
		)
	}
	return byOwner
}

export function buildPackageOwnerNoticeEmail(input: {
	appBaseUrl: string
	content: PackageOwnerNoticeContent
	packages: Array<PackageOwnerNoticePackage>
}) {
	const shown = input.packages.slice(0, maxPackagesListed)
	const hidden = input.packages.length - shown.length
	const packageLines = shown.map((pkg) => {
		const url = new URL(
			`/account/packages/${encodeURIComponent(pkg.packageId)}`,
			input.appBaseUrl,
		).toString()
		return `${pkg.kodyId} (${url}): ${pkg.findings.join(' ')}`
	})
	const effectiveAt = input.content.effectiveAt.trim()
	return renderTransactionalEmail({
		appBaseUrl: input.appBaseUrl,
		subject: input.content.subject,
		preheader:
			input.packages.length === 1
				? `${input.packages[0]!.kodyId} needs a change before a Kody platform rule takes effect.`
				: `${input.packages.length} of your packages need a change before a Kody platform rule takes effect.`,
		heading: input.content.subject,
		body: [
			input.content.whatBreaks,
			...(effectiveAt ? [`This takes effect ${effectiveAt}.`] : []),
			input.packages.length === 1
				? 'Your affected package:'
				: 'Your affected packages:',
			...packageLines,
			...(hidden > 0 ? [`And ${hidden} more.`] : []),
			`How to fix it: ${input.content.howToFix}`,
		],
		action: {
			label: 'Review your packages',
			url: new URL('/account/packages', input.appBaseUrl).toString(),
		},
		footnote:
			"You're receiving this because you own a Kody package that an upcoming platform change affects.",
	})
}

export async function runPackageOwnerNotice(input: {
	env: Env
	runId: string
	noticeId: string
	content: PackageOwnerNoticeContent
	findingMessages?: Array<string> | null
	dryRun: boolean
	cursor?: string | null
	limit?: number | null
}): Promise<PackageOwnerNoticeResult> {
	if (!packageOwnerNoticeIdPattern.test(input.noticeId)) {
		throw new PackageOwnerNoticeError(
			'noticeId must be 3-80 lowercase letters, digits, or dashes (for example "2026-10-body-placeholders").',
		)
	}
	const run = await getPackageCodemodRunById(input.env.APP_DB, input.runId)
	if (!run) {
		throw new PackageOwnerNoticeError(`Codemod run ${input.runId} not found.`)
	}
	if (run.mode !== 'scan') {
		throw new PackageOwnerNoticeError(
			`Codemod run ${run.id} has mode "${run.mode}". Send a notice from a scan run (adminPackageCodemodScan).`,
		)
	}
	if (!input.dryRun && run.status !== 'completed') {
		throw new PackageOwnerNoticeError(
			`Codemod run ${run.id} is ${run.status}. Send a notice only from a completed scan; a dry run can preview a scan in progress.`,
		)
	}
	if (!input.content.effectiveAt.trim()) {
		throw new PackageOwnerNoticeError(
			'effectiveAt is required so owners know when the rule takes effect.',
		)
	}
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	if (!emailConfig) {
		throw new PackageOwnerNoticeError(
			'Transactional email is not configured, so no notice can be rendered or sent.',
		)
	}
	if (!input.dryRun && !kv) {
		throw new PackageOwnerNoticeError(
			'BUNDLE_ARTIFACTS_KV is required to claim notices so owners are emailed once.',
		)
	}

	const byOwner = await loadFlaggedPackagesByOwner({
		db: input.env.APP_DB,
		runId: run.id,
		findingMessages:
			input.findingMessages == null ? null : new Set(input.findingMessages),
	})
	const limit = Math.min(
		Math.max(input.limit ?? packageOwnerNoticeDefaultLimit, 1),
		packageOwnerNoticeMaxLimit,
	)
	const remaining = [...byOwner.keys()]
		.sort()
		.filter((ownerId) => !input.cursor || ownerId > input.cursor)
	const page = remaining.slice(0, limit)

	const owners: Array<PackageOwnerNoticeOwner> = []
	const summary: Partial<Record<PackageOwnerNoticeStatus, number>> = {}
	let preview: PackageOwnerNoticeResult['preview'] = null
	for (const ownerId of page) {
		const packages = byOwner.get(ownerId)!
		const status = await noticeOneOwner({
			env: input.env,
			kv,
			emailConfig,
			noticeId: input.noticeId,
			ownerId,
			packages,
			content: input.content,
			dryRun: input.dryRun,
			onPreview: (email) => {
				preview ??= { subject: email.subject, text: email.text }
			},
		})
		owners.push({ ownerId, packages, ...status })
		summary[status.status] = (summary[status.status] ?? 0) + 1
	}

	return {
		runId: run.id,
		codemodId: run.codemodId,
		noticeId: input.noticeId,
		dryRun: input.dryRun,
		owners,
		summary,
		preview,
		nextCursor: remaining.length > page.length ? (page.at(-1) ?? null) : null,
	}
}

/**
 * Claims are per recipient and written after that recipient's send succeeds,
 * so a re-run skips delivered recipients and retries failed ones. KV has no
 * atomic claim, so run one notice from one place at a time.
 */
async function noticeOneOwner(input: {
	env: Env
	kv: KVNamespace | undefined
	emailConfig: { appBaseUrl: string; fromEmail: string }
	noticeId: string
	ownerId: string
	packages: Array<PackageOwnerNoticePackage>
	content: PackageOwnerNoticeContent
	dryRun: boolean
	onPreview: (email: { subject: string; text: string }) => void
}): Promise<{ status: PackageOwnerNoticeStatus; recipientCount: number }> {
	const recipients = await loadOwnerRecipients(input.env.APP_DB, input.ownerId)
	if (recipients.length === 0) {
		return { status: 'no_recipients', recipientCount: 0 }
	}
	const pending: Array<Recipient & { key: string }> = []
	for (const recipient of recipients) {
		const key = packageOwnerNoticeKvKey({
			noticeId: input.noticeId,
			ownerId: input.ownerId,
			recipientUserId: recipient.userId,
		})
		if (input.kv && (await input.kv.get(key))) continue
		pending.push({ ...recipient, key })
	}
	if (pending.length === 0) {
		return { status: 'already_sent', recipientCount: 0 }
	}
	const email = buildPackageOwnerNoticeEmail({
		appBaseUrl: input.emailConfig.appBaseUrl,
		content: input.content,
		packages: input.packages,
	})
	if (input.dryRun) {
		input.onPreview(email)
		return { status: 'would_send', recipientCount: pending.length }
	}

	let delivered = 0
	let claimFailures = 0
	for (const recipient of pending) {
		try {
			const result = await sendCloudflareEmail(
				{
					accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
					apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
					apiToken: input.env.CLOUDFLARE_API_TOKEN,
				},
				{
					to: recipient.email,
					from: input.emailConfig.fromEmail,
					subject: email.subject,
					html: email.html,
					text: email.text,
				},
			)
			if (!result.ok) {
				console.warn('package-owner-notice-send-skipped', {
					noticeId: input.noticeId,
					ownerId: input.ownerId,
					reason: result.error ?? 'unconfigured',
				})
				continue
			}
			delivered += 1
		} catch (error) {
			console.warn('package-owner-notice-send-failed', {
				noticeId: input.noticeId,
				ownerId: input.ownerId,
				error,
			})
			continue
		}
		try {
			await input.kv?.put(recipient.key, String(Date.now()), {
				expirationTtl: packageOwnerNoticeClaimTtlSeconds,
			})
		} catch (error) {
			claimFailures += 1
			console.warn('package-owner-notice-claim-failed', {
				noticeId: input.noticeId,
				ownerId: input.ownerId,
				error,
			})
		}
	}
	return {
		status:
			delivered < pending.length
				? 'send_failed'
				: claimFailures > 0
					? 'claim_failed'
					: 'sent',
		recipientCount: delivered,
	}
}
