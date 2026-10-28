import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { cliClientName } from '#worker/cli-client-metadata.ts'
import { isAccountEmailVerified } from '#worker/identity/email-verification-state.ts'
import {
	resolveAccessibleOrgBySlug,
	selectConsentOrgsForLoader,
} from '#worker/orgs/oauth-authorize.ts'
import { isOrgAuthorizeError } from '#worker/orgs/authorize-error.ts'
import { listOrgsForPerson } from '#worker/orgs/repo.ts'
import {
	checkRateLimit,
	releaseRateLimit,
	type RateLimitConfig,
} from '#worker/rate-limit.ts'
import {
	deviceGrantClientIds,
	formatUserCode,
	normalizeUserCode,
} from './device-grant.ts'
import {
	decideDeviceAuthorization,
	findPendingDeviceAuthorizationByUserCode,
	type DeviceAuthorizationRow,
} from './store.ts'

/**
 * Code entry is the only place a user_code is guessable, so it is limited per
 * person and per IP. A successful lookup gives its slot back, so only misses
 * count. At 10 misses per 15 minutes a person needs about 2.5 billion windows
 * to cover the 20^8 code space once.
 */
export const deviceUserCodeRateLimit: RateLimitConfig = {
	maxRequests: 10,
	windowSeconds: 15 * 60,
}
export const deviceUserCodeIpRateLimit: RateLimitConfig = {
	maxRequests: 30,
	windowSeconds: 15 * 60,
}

export type DeviceVerificationUser = {
	/** Stable person id (`users.stable_user_id`). */
	personId: string
	email: string
}

export type DeviceVerificationOrg = {
	slug: string
	displayName: string | null
	role: string | null
}

export type DeviceVerificationRequest = {
	userCode: string
	clientName: string
	clientId: string
	scopes: Array<string>
	expiresAt: number
	orgs: Array<DeviceVerificationOrg>
	selectedOrgSlug: string | null
	requestedOrgSlug: string | null
	/** The CLI asked for an org this person cannot use. */
	requestedOrgUnavailable: boolean
}

export type DeviceLookupResult =
	| { kind: 'found'; request: DeviceVerificationRequest }
	| { kind: 'invalid_code' }
	| { kind: 'not_found' }
	| { kind: 'rate_limited'; retryAfterSeconds: number }

export type DeviceDecisionResult =
	| { kind: 'approved' | 'denied' }
	| { kind: 'invalid_code' | 'not_found' | 'email_unverified' }
	| { kind: 'org_error'; message: string }
	| { kind: 'rate_limited'; retryAfterSeconds: number }

function rateLimitKeys(request: Request, user: DeviceVerificationUser) {
	return {
		person: `oauth-device:verify:person:${user.personId}`,
		ip: `oauth-device:verify:ip:${getRequestIp(request) ?? 'unknown'}`,
	}
}

/** Looks a code up under the brute-force limits; misses keep their slot. */
async function findPendingForPerson(input: {
	request: Request
	env: Env
	user: DeviceVerificationUser
	userCode: string | null
}): Promise<
	| { kind: 'found'; row: DeviceAuthorizationRow }
	| { kind: 'invalid_code' | 'not_found' }
	| { kind: 'rate_limited'; retryAfterSeconds: number }
> {
	const userCode = normalizeUserCode(input.userCode)
	if (!userCode) return { kind: 'invalid_code' }
	const keys = rateLimitKeys(input.request, input.user)
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
	const appOrigin = getAppBaseUrl({
		env: input.env,
		requestUrl: input.request.url,
	})
	const row = await findPendingDeviceAuthorizationByUserCode(
		input.env.APP_DB,
		userCode,
	)
	if (!row || !deviceGrantClientIds(appOrigin).includes(row.client_id)) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'oauth',
			action: 'device_verify',
			result: 'failure',
			email: input.user.email,
			ip: getRequestIp(input.request) ?? undefined,
			reason: 'user_code_not_found',
		})
		return { kind: 'not_found' }
	}
	await releaseRateLimit(input.env.APP_DB, keys.person)
	await releaseRateLimit(input.env.APP_DB, keys.ip)
	return { kind: 'found', row }
}

function clientNameFor(clientId: string, appOrigin: string) {
	// v1 only admits the official CLI; a future allowlisted client brings its
	// own CIMD client_name through this switch.
	return deviceGrantClientIds(appOrigin)[0] === clientId
		? cliClientName
		: clientId
}

export async function lookupDeviceAuthorization(input: {
	request: Request
	env: Env
	user: DeviceVerificationUser
	userCode: string | null
}): Promise<DeviceLookupResult> {
	const found = await findPendingForPerson(input)
	if (found.kind !== 'found') return found
	const { row } = found
	const appOrigin = getAppBaseUrl({
		env: input.env,
		requestUrl: input.request.url,
	})
	const accessible = await listOrgsForPerson(
		input.env.APP_DB,
		input.user.personId,
	)
	const requestedOrgUnavailable = Boolean(
		row.requested_org_slug &&
		!accessible.some((org) => org.slug === row.requested_org_slug),
	)
	const consent = selectConsentOrgsForLoader(accessible, row.requested_org_slug)
	// A sign-in started for an org this person cannot use must not fall back to
	// their sole org on the consent screen; approve would refuse it anyway.
	const orgs = requestedOrgUnavailable ? [] : consent.orgs
	const selectedOrgSlug = requestedOrgUnavailable
		? null
		: consent.selectedOrgSlug
	return {
		kind: 'found',
		request: {
			userCode: formatUserCode(row.user_code),
			clientName: clientNameFor(row.client_id, appOrigin),
			clientId: row.client_id,
			scopes: row.scope.split(' ').filter(Boolean),
			expiresAt: row.expires_at,
			orgs,
			selectedOrgSlug,
			requestedOrgSlug: row.requested_org_slug,
			requestedOrgUnavailable,
		},
	}
}

export async function decideDeviceAuthorizationForPerson(input: {
	request: Request
	env: Env
	user: DeviceVerificationUser
	userCode: string | null
	decision: 'approve' | 'deny'
	orgSlug: string | null
}): Promise<DeviceDecisionResult> {
	const found = await findPendingForPerson(input)
	if (found.kind !== 'found') return found
	const { row } = found
	const personId = personIdFromStored(input.user.personId)
	const ip = getRequestIp(input.request) ?? undefined
	if (input.decision === 'deny') {
		const denied = await decideDeviceAuthorization(input.env.APP_DB, {
			id: row.id,
			decision: 'denied',
			userId: personId,
		})
		void logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'oauth',
			action: 'device_verify',
			result: 'success',
			email: input.user.email,
			ip,
			clientId: row.client_id,
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
	let orgId: string
	try {
		const requested = input.orgSlug ?? row.requested_org_slug
		if (requested) {
			if (
				row.requested_org_slug &&
				input.orgSlug &&
				row.requested_org_slug !== input.orgSlug
			) {
				return {
					kind: 'org_error',
					message: `This sign-in was started for @${row.requested_org_slug}.`,
				}
			}
			orgId = (
				await resolveAccessibleOrgBySlug({
					db: input.env.APP_DB,
					userId: personId,
					slug: requested,
				})
			).orgId
		} else {
			const orgs = await listOrgsForPerson(input.env.APP_DB, personId)
			const sole = orgs.length === 1 ? orgs[0] : null
			if (!sole) {
				return {
					kind: 'org_error',
					message: 'Choose the organization this sign-in is for.',
				}
			}
			orgId = sole.id
		}
	} catch (error) {
		if (isOrgAuthorizeError(error)) {
			return { kind: 'org_error', message: error.message }
		}
		throw error
	}
	const approved = await decideDeviceAuthorization(input.env.APP_DB, {
		id: row.id,
		decision: 'approved',
		userId: personId,
		orgId,
	})
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'oauth',
		action: 'device_verify',
		result: approved ? 'success' : 'failure',
		email: input.user.email,
		ip,
		clientId: row.client_id,
		...(approved ? {} : { reason: 'not_pending' }),
	})
	return approved ? { kind: 'approved' } : { kind: 'not_found' }
}
