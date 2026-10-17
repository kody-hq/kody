import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { type BillingPageOrg } from '#app/account-billing-data.ts'
import { loadAccountUsageData } from '#app/account-usage-data.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	authorize,
	AuthorizationError,
} from '#worker/authorization/authorize.ts'
import { orgUsageCreditsPath, orgUsagePath } from '#universal/org-pages.ts'
import {
	applyCreditTopUpFromCheckoutSession,
	CreditTopUpError,
} from '#worker/billing/credit-top-ups.ts'
import { getOrgById, loadOrgBindingForSlug } from '#worker/orgs/repo.ts'

type OrgUsageAccess =
	| { ok: true; org: BillingPageOrg }
	| { ok: false; status: 403 | 404; error: string }

const creditsNoticeMessages: Record<string, string> = {
	added:
		'Credits added. Usage past your monthly include runs on them within a minute.',
}

const creditsErrorMessages: Record<string, string> = {
	topup_failed: 'We could not confirm that top-up. Refresh in a moment.',
	not_paid: 'That top-up has not been paid yet.',
	client_reference_mismatch: 'That top-up does not belong to your account.',
}

function readMessage(
	messages: Record<string, string>,
	code: string | null,
): string | undefined {
	return code && Object.hasOwn(messages, code) ? messages[code] : undefined
}

/**
 * The organization a `/@slug/-/usage...` request reads, when the person may
 * use `permission` there. Same bind + authorize path as org billing: a slug
 * the person cannot reach is a 404, never a silent fall back to their signup
 * organization.
 */
async function resolveOrgUsageAccess(input: {
	orgSlug: string
	env: Env
	user: AuthenticatedAppUser
	permission: Extract<OrgPermission, 'billing:read' | 'billing:write'>
}): Promise<OrgUsageAccess> {
	const resolution = await loadOrgBindingForSlug(
		input.env.APP_DB,
		input.user.mcpUser.userId,
		input.orgSlug,
	)
	if (!resolution || resolution.org.id !== input.user.request.org.id) {
		return { ok: false, status: 404, error: 'Organization unavailable.' }
	}
	const slug = resolution.org.slug ?? input.user.username
	try {
		await authorize(
			{ env: input.env, request: input.user.request },
			input.permission,
		)
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error
		return {
			ok: false,
			status: 403,
			error: `Only owners and billing admins can view usage for @${slug}.`,
		}
	}
	const record = await getOrgById(input.env.APP_DB, resolution.org.id)
	if (!record) {
		throw new Error(`Cannot load usage: missing org ${resolution.org.id}.`)
	}
	return {
		ok: true,
		org: {
			id: resolution.org.id,
			slug: record.slug,
			displayName: record.display_name,
			personal:
				resolution.org.id === personalOrgIdForPerson(input.user.mcpUser),
		},
	}
}

/** Foreground checkout completion, separate from reusable usage reads. */
export async function completeOrgCreditTopUp(input: {
	env: Env
	user: AuthenticatedAppUser
	orgSlug: string
	sessionId: string
}) {
	const { env } = input
	const access = await resolveOrgUsageAccess({
		...input,
		permission: 'billing:read',
	})
	if (!access.ok)
		return {
			kind: 'denied' as const,
			status: access.status,
			error: access.error,
		}
	let query: Record<string, string>
	try {
		await applyCreditTopUpFromCheckoutSession({
			env,
			sessionId: input.sessionId.trim(),
			expectedStableUserId: access.org.id,
			now: new Date(),
		})
		query = { credits: 'added' }
	} catch (error) {
		const code = error instanceof CreditTopUpError ? error.code : 'topup_failed'
		console.error('credit_top_up_confirm_failed', { code })
		query = {
			error: readMessage(creditsErrorMessages, code) ? code : 'topup_failed',
		}
	}
	const target = new URL(
		orgUsageCreditsPath(access.org.slug),
		'https://kody.local',
	)
	target.search = new URLSearchParams(query).toString()
	return {
		kind: 'redirect' as const,
		href: target.pathname + target.search + target.hash,
	}
}

export async function loadOrgUsagePageResult(input: {
	env: Env
	user: AuthenticatedAppUser
	orgSlug: string
	credits: string | null
	error: string | null
	topup: string | null
	sessionId: string | null
}) {
	const { env, user } = input
	const access = await resolveOrgUsageAccess({
		...input,
		permission: 'billing:read',
	})
	if (!access.ok)
		return {
			kind: 'denied' as const,
			status: access.status,
			error: access.error,
		}
	const payload = await loadAccountUsageData({
		env,
		userId: user.userId,
		org: access.org,
		notice: readMessage(creditsNoticeMessages, input.credits),
		error: readMessage(creditsErrorMessages, input.error),
	})
	if (!payload)
		return { kind: 'denied' as const, status: 404 as const, error: 'Not found' }
	return { kind: 'data' as const, payload }
}

/** Personal-org usage URL for legacy `/account/usage` and `/account/credits`. */
export function personalOrgUsageRedirectUrl(input: {
	requestUrl: string
	slug: string
	/** When true, land on the Credits section (`#credits`). */
	credits?: boolean
}): string {
	const target = new URL(
		input.credits ? orgUsageCreditsPath(input.slug) : orgUsagePath(input.slug),
		input.requestUrl,
	)
	target.search = new URL(input.requestUrl).search
	return target.toString()
}
