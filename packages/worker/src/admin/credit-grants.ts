/**
 * Admin credit grants: house-funded wallet top-ups for any account,
 * including the signed-in admin. Shared by the admin users page and the
 * `adminCreditGrant` / `adminCreditWalletGet` capabilities so both write
 * the same ledger row (granted_by, amount, recipient, time, note) and the
 * same audit event. `adminCreditEligibilitySet` owns the admin half of
 * wallet eligibility (`orgs.admin_credits_eligible`).
 */
/**
 * soft-delete-read-filter: opt-out
 *
 * The admin wallet reader can inspect wallets owned by deleted organizations.
 */
import {
	type AdminCreditLedgerItem,
	type AdminCreditWalletSummary,
} from '#universal/loader-data.ts'
import {
	creditAdminGrantNoteMaxLength,
	validateCreditAdminGrantCents,
} from '#universal/credits.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import {
	ensureCreditWallet,
	grantAdminCredits,
	listCreditLedgerEntries,
	readCreditWallet,
	toAccountCreditsLedgerItem,
} from '#worker/billing/credit-wallet.ts'
import {
	invalidateCachedUserEntitlement,
	resolveUserEntitlementFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { parseOwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type AdminUserTarget } from './users-data.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { writeOrgCreditEligibility } from './org-billing-mutations.ts'

const adminCreditLedgerLimit = 20

export class AdminCreditGrantError extends Error {
	readonly status: 400 | 404
	constructor(status: 400 | 404, message: string) {
		super(message)
		this.name = 'AdminCreditGrantError'
		this.status = status
	}
}

type CreditGrantTargetRow = UserEntitlementRow & {
	id: number
	stable_user_id: string
	org_id: string
	username: string
}

async function loadCreditGrantTarget(
	db: D1Database,
	target: AdminUserTarget,
): Promise<CreditGrantTargetRow | null> {
	const columns = `u.id, u.stable_user_id, o.id AS org_id, u.username, ${userEntitlementColumnsSql('o')}`
	const fromSql = `users u INNER JOIN orgs o ON o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)${andLiveDeletedAtSql('o')}`
	if (target.stableUserId !== undefined) {
		const stableUserId = parseOwnerId(target.stableUserId)
		if (!stableUserId) return null
		return db
			.prepare(
				`SELECT ${columns} FROM ${fromSql} WHERE u.stable_user_id = ?${andLiveDeletedAtSql('u')}`,
			)
			.bind(stableUserId)
			.first<CreditGrantTargetRow>()
	}
	if (target.email !== undefined) {
		return db
			.prepare(
				`SELECT ${columns} FROM ${fromSql} WHERE lower(u.email) = ?${andLiveDeletedAtSql('u')}`,
			)
			.bind(normalizeEmail(target.email))
			.first<CreditGrantTargetRow>()
	}
	if (target.username !== undefined) {
		return db
			.prepare(
				`SELECT ${columns} FROM ${fromSql} WHERE u.username = ?${andLiveDeletedAtSql('u')}`,
			)
			.bind(target.username.trim())
			.first<CreditGrantTargetRow>()
	}
	return null
}

async function loadGranterUsernames(
	db: D1Database,
	stableUserIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
	const unique = [...new Set(stableUserIds)]
	if (unique.length === 0) return new Map()
	const rows = await db
		.prepare(
			`SELECT stable_user_id, username FROM users
			 WHERE stable_user_id IN (${unique.map(() => '?').join(', ')})${andLiveDeletedAtSql()}`,
		)
		.bind(...unique)
		.all<{ stable_user_id: string; username: string }>()
	return new Map(
		(rows.results ?? []).map((row) => [row.stable_user_id, row.username]),
	)
}

export async function loadAdminCreditWallet(
	env: Env,
	target: AdminUserTarget,
): Promise<AdminCreditWalletSummary | null> {
	const db = env.APP_DB
	const row = await loadCreditGrantTarget(db, target)
	if (!row) return null
	return readAdminCreditWallet(db, row, row.stable_user_id, row.username)
}

async function readAdminCreditWallet(
	db: D1Database,
	row: UserEntitlementRow & { org_id: string; username: string },
	stableUserId: string,
	username: string,
): Promise<AdminCreditWalletSummary> {
	const orgId = row.org_id
	const [entitlement, wallet, entries] = await Promise.all([
		resolveUserEntitlementFromRow({ db, stableUserId: orgId, row }),
		readCreditWallet(db, orgId),
		listCreditLedgerEntries({
			db,
			userId: orgId,
			limit: adminCreditLedgerLimit,
		}),
	])
	const granters = await loadGranterUsernames(
		db,
		entries.flatMap((entry) =>
			entry.grantedByUserId ? [entry.grantedByUserId] : [],
		),
	)
	const recent: Array<AdminCreditLedgerItem> = entries.map((entry) => ({
		...toAccountCreditsLedgerItem(entry),
		grantedByUsername: entry.grantedByUserId
			? (granters.get(entry.grantedByUserId) ?? 'deleted-user')
			: null,
		note: entry.note,
	}))
	return {
		ok: true,
		stableUserId,
		username,
		plan: entitlement.plan,
		eligible: entitlement.creditWallet !== 'none',
		adminCreditsEligible: Number(row.admin_credits_eligible) === 1,
		unlocked: entitlement.creditWallet === 'funded',
		balanceMicroUsd: wallet.balanceMicroUsd,
		recent,
	}
}

/** Read a wallet by its owning organization, including deleted organizations. */
export async function loadAdminCreditWalletByOrgId(
	db: D1Database,
	orgId: string,
): Promise<AdminCreditWalletSummary | null> {
	const row = await db
		.prepare(
			`SELECT o.id AS org_id, o.slug AS username, ${userEntitlementColumnsSql('o')}
			 FROM orgs o WHERE o.id = ?`,
		)
		.bind(orgId)
		.first<UserEntitlementRow & { org_id: string; username: string }>()
	if (!row) return null
	return readAdminCreditWallet(db, row, row.org_id, row.username)
}

export function parseAdminCreditGrantNote(value: unknown): string | null {
	if (value === undefined || value === null) return null
	if (typeof value !== 'string') {
		throw new AdminCreditGrantError(400, 'Note must be text.')
	}
	const note = value.trim()
	if (note.length > creditAdminGrantNoteMaxLength) {
		throw new AdminCreditGrantError(
			400,
			`Note is limited to ${creditAdminGrantNoteMaxLength} characters.`,
		)
	}
	return note || null
}

export async function grantAdminCreditsToUser(input: {
	env: Env
	target: AdminUserTarget
	grantedBy: { stableUserId: string; email: string }
	amountCents: unknown
	note: unknown
	path: string
	ip?: string
	/** MCP callers audit through `auditAdminCapabilityInvocation` instead. */
	audit?: boolean
	now?: Date
}): Promise<{
	entryId: string
	amountCents: number
	wallet: AdminCreditWalletSummary
}> {
	const amount = validateCreditAdminGrantCents(input.amountCents)
	if (!amount.ok) throw new AdminCreditGrantError(400, amount.error)
	const note = parseAdminCreditGrantNote(input.note)
	const db = input.env.APP_DB
	const now = input.now ?? new Date()
	const row = await loadCreditGrantTarget(db, input.target)
	if (!row) throw new AdminCreditGrantError(404, 'User not found.')
	const orgId = row.org_id
	await ensureCreditWallet({
		db,
		userId: orgId,
		entitlement: await resolveUserEntitlementFromRow({
			db,
			stableUserId: orgId,
			row,
			now,
		}),
		now,
	})
	const grant = await grantAdminCredits({
		db,
		recipientUserId: orgId,
		grantedByUserId: input.grantedBy.stableUserId,
		amountCents: amount.cents,
		note,
		now,
	})
	invalidateCachedUserEntitlement(db, orgId)
	if (input.audit !== false) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'admin',
			action: 'grant_credits',
			result: 'success',
			email: input.grantedBy.email,
			ip: input.ip,
			path: input.path,
			reason: formatAdminCreditGrantAuditReason({
				stableUserId: row.stable_user_id,
				amountCents: amount.cents,
				entryId: grant.entryId,
			}),
		})
	}
	const wallet = await loadAdminCreditWallet(input.env, {
		stableUserId: row.stable_user_id,
	})
	if (!wallet) throw new AdminCreditGrantError(404, 'User not found.')
	return { entryId: grant.entryId, amountCents: amount.cents, wallet }
}

export function formatAdminCreditGrantAuditReason(input: {
	stableUserId: string
	amountCents: number
	entryId: string
}) {
	return `target_stable_user_id=${input.stableUserId};amount_cents=${input.amountCents};entry_id=${input.entryId}`
}

/**
 * Set or clear `orgs.admin_credits_eligible`. With an effective `pro` plan
 * (for example a manual `adminUserUpdate` grant) this unlocks the wallet
 * exactly like the purchasable Pro price: a positive balance lifts limits and
 * past-include usage debits it. Clearing it leaves the balance on hold. It
 * never creates Stripe customers or subscriptions, and it does not enable
 * buying credits or auto-refill. Callers own the audit event
 * ({@link formatAdminCreditEligibilityAuditReason}).
 */
export async function setAdminCreditEligibility(input: {
	env: Env
	target: AdminUserTarget
	creditsEligible: boolean
	note: unknown
	now?: Date
}): Promise<{
	previousAdminCreditsEligible: boolean
	note: string | null
	wallet: AdminCreditWalletSummary
}> {
	const note = parseAdminCreditGrantNote(input.note)
	const db = input.env.APP_DB
	const now = input.now ?? new Date()
	const row = await loadCreditGrantTarget(db, input.target)
	if (!row) throw new AdminCreditGrantError(404, 'User not found.')
	const orgId = row.org_id
	const previousAdminCreditsEligible = await writeOrgCreditEligibility({
		db,
		orgId,
		creditsEligible: input.creditsEligible,
		now,
	})
	const wallet = await loadAdminCreditWallet(input.env, {
		stableUserId: row.stable_user_id,
	})
	if (!wallet) throw new AdminCreditGrantError(404, 'User not found.')
	return { previousAdminCreditsEligible, note, wallet }
}

export function formatAdminCreditEligibilityAuditReason(input: {
	stableUserId: string
	creditsEligible: boolean
	previousAdminCreditsEligible: boolean
	note: string | null
}) {
	const parts = [
		`target_stable_user_id=${input.stableUserId}`,
		`admin_credits_eligible=${input.creditsEligible ? 1 : 0}`,
		`previous=${input.previousAdminCreditsEligible ? 1 : 0}`,
	]
	if (input.note) parts.push(`note=${encodeURIComponent(input.note)}`)
	return parts.join(';')
}
