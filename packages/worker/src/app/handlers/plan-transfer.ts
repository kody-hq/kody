import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import type { BillingPageOrg } from '#app/account-billing-data.ts'
import { operationResult } from '../operation-result.ts'
import { resolveOrgBillingAccess } from './org-billing.ts'
import { isPaidOrgBilling } from '#worker/orgs/billing.ts'
import { andActiveOrgSql } from '#worker/soft-delete/live-sql.ts'
import { parseBillingInterval } from '#worker/billing/billing-config.ts'
import {
	advancePlanTransfer,
	cancelPlanTransfer,
	planTransferBlockMessage,
	previewPlanTransfer,
	readPlanTransfer,
	resumeOpenPlanTransferForOrg,
	startPlanTransfer,
	type PlanTransferBlockReason,
	type PlanTransferRow,
} from '#worker/billing/plan-transfer.ts'
import type {
	AccountBillingMovePlanLoaderData,
	PlanTransferSummary,
} from '#universal/loader-data.ts'

const transferIdPattern = /^[a-zA-Z0-9_-]{8,64}$/

const stepErrorMessage =
	'Stripe did not finish the last step. Nothing is lost: retry to pick up where it stopped.'

const movePlanNotices: Record<string, string> = {
	plan_transfer_checkout_canceled:
		'Checkout was canceled, so nothing was charged and your plan has not moved.',
}

type OwnedOrgRow = {
	id: string
	slug: string
	display_name: string | null
	plan: string
	stripe_plan: string | null
	personal: number
}

async function listOwnedOrgs(db: D1Database, userId: string) {
	const rows = await db
		.prepare(
			`SELECT o.id, o.slug, o.display_name, o.plan, o.stripe_plan,
			        EXISTS (
			          SELECT 1 FROM users u
			          WHERE COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id) = o.id
			        ) AS personal
			 FROM orgs o
			 INNER JOIN org_memberships m
			   ON m.org_id = o.id AND m.user_id = ? AND m.role = 'owner' AND m.deleted_at IS NULL
			 WHERE 1 = 1${andActiveOrgSql('o')}
			 ORDER BY o.slug ASC`,
		)
		.bind(userId)
		.all<OwnedOrgRow>()
	return rows.results ?? []
}

async function readOrgSlug(db: D1Database, orgId: string) {
	const row = await db
		.prepare(`SELECT slug FROM orgs WHERE id = ? AND deleted_at IS NULL`)
		.bind(orgId)
		.first<{ slug: string }>()
	return row?.slug ?? null
}

function isBlockReason(code: string): code is PlanTransferBlockReason {
	try {
		return Boolean(planTransferBlockMessage(code as PlanTransferBlockReason))
	} catch {
		return false
	}
}

async function summarizeTransfer(
	db: D1Database,
	row: PlanTransferRow,
	orgId: string,
): Promise<PlanTransferSummary> {
	const [sourceSlug, targetSlug] = await Promise.all([
		readOrgSlug(db, row.source_org_id),
		readOrgSlug(db, row.target_org_id),
	])
	const code = row.last_error_code
	const errorMessage =
		row.status === 'needs_retry' && code
			? isBlockReason(code)
				? planTransferBlockMessage(code)
				: code === 'target_not_paid'
					? 'Checkout for the other organization has not completed yet.'
					: stepErrorMessage
			: row.status === 'canceled' && code === 'checkout_expired'
				? 'Checkout expired before payment, so the move was canceled and nothing changed.'
				: null
	return {
		id: row.id,
		status: row.status,
		role: row.source_org_id === orgId ? 'source' : 'target',
		sourceSlug,
		targetSlug,
		creditAmountMinor: row.credit_amount_minor,
		currency: row.currency,
		cancelable:
			row.credit_amount_minor == null &&
			(row.status === 'pending_checkout' || row.status === 'needs_retry'),
		errorMessage,
		completedAt: row.completed_at,
	}
}

export async function loadPlanTransferPageData(input: {
	env: Env
	user: AuthenticatedAppUser
	org: BillingPageOrg
	targetSlug: string | null
	interval: string | null
	noticeCode: string | null
	transferId: string | null
}): Promise<AccountBillingMovePlanLoaderData> {
	const { env, user, org } = input
	const db = env.APP_DB
	const userId = user.mcpUser.userId
	const latest = await resumeOpenPlanTransferForOrg({ env, orgId: org.id })
	const shown =
		input.transferId && transferIdPattern.test(input.transferId)
			? await readPlanTransfer(db, input.transferId)
			: latest
	const transferRow =
		shown &&
		(shown.source_org_id === org.id || shown.target_org_id === org.id) &&
		(shown.status !== 'canceled' || shown.id === input.transferId)
			? shown
			: null
	const owned = await listOwnedOrgs(db, userId)
	const targets = owned
		.filter((row) => row.id !== org.id)
		.map((row) => ({
			id: row.id,
			slug: row.slug,
			displayName: row.display_name,
			personal: Boolean(row.personal),
			paid: isPaidOrgBilling(row),
		}))
	const selected =
		targets.find((target) => target.slug === input.targetSlug) ?? null
	const interval = parseBillingInterval(input.interval)
	let preview: AccountBillingMovePlanLoaderData['preview'] = null
	let blocked: AccountBillingMovePlanLoaderData['blocked'] = null
	const transferOpen =
		transferRow != null &&
		['pending_checkout', 'applying', 'needs_retry'].includes(transferRow.status)
	if (!owned.some((row) => row.id === org.id)) {
		blocked = {
			reason: 'not_owner_source',
			message: planTransferBlockMessage('not_owner_source'),
		}
	} else if (selected && !transferOpen) {
		const result = await previewPlanTransfer({
			env,
			actorUserId: userId,
			sourceOrgId: org.id,
			targetOrgId: selected.id,
			targetInterval: interval,
		})
		if (result.ok) preview = result.preview
		else blocked = { reason: result.reason, message: result.message }
	}
	return {
		ok: true,
		source: {
			slug: org.slug,
			displayName: org.displayName,
			personal: org.personal,
		},
		targets: targets.map(({ id: _id, ...target }) => target),
		selectedTargetSlug: selected?.slug ?? null,
		interval,
		preview,
		blocked,
		transfer: transferRow
			? await summarizeTransfer(db, transferRow, org.id)
			: null,
		...(input.noticeCode && movePlanNotices[input.noticeCode]
			? { notice: movePlanNotices[input.noticeCode] }
			: {}),
	}
}

async function resolveOwnedTarget(
	db: D1Database,
	userId: string,
	slug: unknown,
) {
	if (typeof slug !== 'string') return null
	const owned = await listOwnedOrgs(db, userId)
	return owned.find((row) => row.slug === slug) ?? null
}

/** Confirms a previewed move. `transferId` is generated by the page so a double submit is one move. */
export async function startWebsitePlanTransfer(input: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	orgSlug: string
	body: unknown
}) {
	const { env, request, user } = input
	const access = await resolveOrgBillingAccess({
		request,
		env,
		user,
		permission: 'billing:write',
		orgSlug: input.orgSlug,
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}
	const body = input.body as {
		targetSlug?: unknown
		interval?: unknown
		transferId?: unknown
	} | null
	const transferId =
		typeof body?.transferId === 'string' &&
		transferIdPattern.test(body.transferId)
			? body.transferId
			: null
	if (!transferId) {
		return operationResult({ ok: false, error: 'Reload and try again.' }, 400)
	}
	const interval = parseBillingInterval(body?.interval) ?? 'month'
	const target = await resolveOwnedTarget(
		env.APP_DB,
		user.mcpUser.userId,
		body?.targetSlug,
	)
	if (!target) {
		return operationResult(
			{ ok: false, error: planTransferBlockMessage('not_owner_target') },
			403,
		)
	}
	const result = await startPlanTransfer({
		env,
		actorUserId: user.mcpUser.userId,
		actorEmail: user.email ?? null,
		transferId,
		sourceOrgId: access.org.id,
		targetOrgId: target.id,
		targetInterval: interval,
		origin: new URL(request.url).origin,
	})
	if (!result.ok) {
		return operationResult({ ok: false, error: result.message }, 409)
	}
	return operationResult({
		ok: true,
		transferId: result.transfer.id,
		status: result.transfer.status,
		checkoutUrl: result.checkoutUrl ?? null,
	})
}

async function resolveTransferForActor(input: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	orgSlug: string
	body: unknown
}) {
	const access = await resolveOrgBillingAccess({
		request: input.request,
		env: input.env,
		user: input.user,
		permission: 'billing:write',
		orgSlug: input.orgSlug,
	})
	if (!access.ok) return { ok: false as const, access }
	const body = input.body as { transferId?: unknown } | null
	const transferId =
		typeof body?.transferId === 'string' ? body.transferId : null
	const row = transferId
		? await readPlanTransfer(input.env.APP_DB, transferId)
		: null
	if (
		!row ||
		(row.source_org_id !== access.org.id && row.target_org_id !== access.org.id)
	) {
		return {
			ok: false as const,
			access: {
				ok: false as const,
				status: 404 as const,
				error: 'Plan move not found.',
			},
		}
	}
	return { ok: true as const, row, org: access.org }
}

export async function retryWebsitePlanTransfer(input: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	orgSlug: string
	body: unknown
}) {
	const resolved = await resolveTransferForActor(input)
	if (!resolved.ok) {
		return operationResult(
			{ ok: false, error: resolved.access.error },
			resolved.access.status,
		)
	}
	const owned = await listOwnedOrgs(input.env.APP_DB, input.user.mcpUser.userId)
	if (!owned.some((row) => row.id === resolved.org.id)) {
		return operationResult(
			{ ok: false, error: planTransferBlockMessage('not_owner_source') },
			403,
		)
	}
	const row = await advancePlanTransfer({
		env: input.env,
		transferId: resolved.row.id,
	})
	return operationResult({ ok: true, status: row?.status ?? null })
}

export async function cancelWebsitePlanTransfer(input: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	orgSlug: string
	body: unknown
}) {
	const resolved = await resolveTransferForActor(input)
	if (!resolved.ok) {
		return operationResult(
			{ ok: false, error: resolved.access.error },
			resolved.access.status,
		)
	}
	const result = await cancelPlanTransfer({
		env: input.env,
		actorUserId: input.user.mcpUser.userId,
		transferId: resolved.row.id,
	})
	if (!result.ok) {
		return operationResult(
			{
				ok: false,
				error:
					'This move already credited the unused value, so it can only be finished. Retry instead.',
			},
			409,
		)
	}
	return operationResult({ ok: true, status: 'canceled' })
}
