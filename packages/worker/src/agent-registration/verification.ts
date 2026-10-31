import { type AgentClaimRequest } from './claim-types.ts'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import { isAccountEmailVerified } from '#worker/identity/email-verification-state.ts'
import { normalizeUserCode } from '#worker/oauth-device/device-grant.ts'
import {
	deviceUserCodeIpRateLimit,
	deviceUserCodeRateLimit,
} from '#worker/oauth-device/verification.ts'
import { isOrgAuthorizeError } from '#worker/orgs/authorize-error.ts'
import {
	resolveAccessibleOrgBySlug,
	selectConsentOrgsForLoader,
} from '#worker/orgs/oauth-authorize.ts'
import { listOrgsForPerson } from '#worker/orgs/repo.ts'
import { checkRateLimit, releaseRateLimit } from '#worker/rate-limit.ts'
import {
	decideAgentRegistration,
	findOpenAgentRegistrationByAttemptTokenHash,
	hashAgentRegistrationSecret,
	type AgentRegistrationRow,
} from './store.ts'

export type AgentClaimUser = {
	/** Stable person id (`users.stable_user_id`). */
	personId: string
	email: string
}

export type { AgentClaimOrg, AgentClaimRequest } from './claim-types.ts'

export type AgentClaimLookupResult =
	| { kind: 'found'; request: AgentClaimRequest }
	| { kind: 'not_found' }
	| { kind: 'email_mismatch'; claimEmail: string }

export type AgentClaimDecisionResult =
	| { kind: 'approved' | 'denied' }
	| { kind: 'not_found' | 'invalid_code' | 'email_unverified' }
	| { kind: 'email_mismatch'; claimEmail: string }
	| { kind: 'org_error'; message: string }
	| { kind: 'rate_limited'; retryAfterSeconds: number }

async function findOpenRegistration(
	env: Env,
	attemptToken: string | null,
): Promise<AgentRegistrationRow | null> {
	if (!attemptToken) return null
	return await findOpenAgentRegistrationByAttemptTokenHash(
		env.APP_DB,
		await hashAgentRegistrationSecret(attemptToken),
	)
}

function emailMatches(row: AgentRegistrationRow, user: AgentClaimUser) {
	return normalizeEmailAddress(user.email) === row.claim_email
}

export async function lookupAgentClaim(input: {
	env: Env
	user: AgentClaimUser
	attemptToken: string | null
}): Promise<AgentClaimLookupResult> {
	const row = await findOpenRegistration(input.env, input.attemptToken)
	if (!row) return { kind: 'not_found' }
	if (!emailMatches(row, input.user)) {
		return { kind: 'email_mismatch', claimEmail: row.claim_email }
	}
	const accessible = await listOrgsForPerson(
		input.env.APP_DB,
		input.user.personId,
	)
	const consent = selectConsentOrgsForLoader(accessible, null)
	return {
		kind: 'found',
		request: {
			claimEmail: row.claim_email,
			attemptExpiresAt: row.attempt_expires_at,
			orgs: consent.orgs,
			selectedOrgSlug: consent.selectedOrgSlug,
		},
	}
}

/** Checks a typed code under the per-person and per-IP miss limits. */
async function checkUserCode(input: {
	request: Request
	env: Env
	user: AgentClaimUser
	row: AgentRegistrationRow
	userCode: string | null
}): Promise<
	| { kind: 'ok' }
	| { kind: 'invalid_code' }
	| { kind: 'rate_limited'; retryAfterSeconds: number }
> {
	const userCode = normalizeUserCode(input.userCode)
	if (!userCode) return { kind: 'invalid_code' }
	const keys = {
		person: `agent-claim:verify:person:${input.user.personId}`,
		ip: `agent-claim:verify:ip:${getRequestIp(input.request) ?? 'unknown'}`,
	}
	const person = await checkRateLimit(
		input.env.APP_DB,
		keys.person,
		deviceUserCodeRateLimit,
	)
	if (!person.allowed) {
		return {
			kind: 'rate_limited',
			retryAfterSeconds: person.retryAfterSeconds ?? 60,
		}
	}
	const ip = await checkRateLimit(
		input.env.APP_DB,
		keys.ip,
		deviceUserCodeIpRateLimit,
	)
	if (!ip.allowed) {
		await releaseRateLimit(input.env.APP_DB, keys.person)
		return {
			kind: 'rate_limited',
			retryAfterSeconds: ip.retryAfterSeconds ?? 60,
		}
	}
	if (
		(await hashAgentRegistrationSecret(userCode)) !== input.row.user_code_hash
	) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'oauth',
			action: 'agent_claim',
			result: 'failure',
			email: input.user.email,
			ip: getRequestIp(input.request) ?? undefined,
			reason: 'user_code_mismatch',
		})
		return { kind: 'invalid_code' }
	}
	await releaseRateLimit(input.env.APP_DB, keys.person)
	await releaseRateLimit(input.env.APP_DB, keys.ip)
	return { kind: 'ok' }
}

async function resolveClaimOrgId(input: {
	env: Env
	personId: string
	orgSlug: string | null
}): Promise<{ orgId: string } | { message: string }> {
	try {
		if (input.orgSlug) {
			return {
				orgId: (
					await resolveAccessibleOrgBySlug({
						db: input.env.APP_DB,
						userId: input.personId,
						slug: input.orgSlug,
					})
				).orgId,
			}
		}
		const orgs = await listOrgsForPerson(input.env.APP_DB, input.personId)
		const sole = orgs.length === 1 ? orgs[0] : null
		return sole
			? { orgId: sole.id }
			: { message: 'Choose the organization this agent is for.' }
	} catch (error) {
		if (isOrgAuthorizeError(error)) return { message: error.message }
		throw error
	}
}

export async function decideAgentClaimForPerson(input: {
	request: Request
	env: Env
	user: AgentClaimUser
	attemptToken: string | null
	userCode: string | null
	decision: 'approve' | 'deny'
	orgSlug: string | null
}): Promise<AgentClaimDecisionResult> {
	const row = await findOpenRegistration(input.env, input.attemptToken)
	if (!row) return { kind: 'not_found' }
	if (!emailMatches(row, input.user)) {
		return { kind: 'email_mismatch', claimEmail: row.claim_email }
	}
	const personId = personIdFromStored(input.user.personId)
	const ip = getRequestIp(input.request) ?? undefined
	if (input.decision === 'deny') {
		const denied = await decideAgentRegistration(input.env.APP_DB, {
			id: row.id,
			attemptId: row.attempt_id,
			decision: 'denied',
			userId: personId,
		})
		void logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'oauth',
			action: 'agent_claim',
			result: 'success',
			email: input.user.email,
			ip,
			reason: 'denied',
		})
		return denied ? { kind: 'denied' } : { kind: 'not_found' }
	}
	const verified = await isAccountEmailVerified({
		db: input.env.APP_DB,
		email: input.user.email,
		stableUserId: personId,
	})
	if (!verified) return { kind: 'email_unverified' }
	const code = await checkUserCode({ ...input, row })
	if (code.kind !== 'ok') return code
	const org = await resolveClaimOrgId({
		env: input.env,
		personId,
		orgSlug: input.orgSlug,
	})
	if ('message' in org) return { kind: 'org_error', message: org.message }
	const claimed = await decideAgentRegistration(input.env.APP_DB, {
		id: row.id,
		attemptId: row.attempt_id,
		decision: 'claimed',
		userId: personId,
		orgId: org.orgId,
	})
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'oauth',
		action: 'agent_claim',
		result: claimed ? 'success' : 'failure',
		email: input.user.email,
		ip,
		...(claimed ? {} : { reason: 'not_pending' }),
	})
	return claimed ? { kind: 'approved' } : { kind: 'not_found' }
}
