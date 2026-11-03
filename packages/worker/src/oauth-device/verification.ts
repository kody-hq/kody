import { waitUntil } from 'cloudflare:workers'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	accountDeviceApproveRateLimit,
	describeAccountDeviceRequest,
	notifyAccountDeviceSignInApproved,
	type AccountDeviceVerificationRequest,
} from '#app/account-device-sign-in.ts'
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
	decideAccountDeviceAuthorization,
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
	/** A package-app visitor sign-in; approve it on the app's consent page. */
	| { kind: 'package_app'; userCode: string }
	/** A browser asking to sign in to this person's full Kody account. */
	| { kind: 'account'; request: AccountDeviceVerificationRequest }
	| { kind: 'invalid_code' }
	| { kind: 'not_found' }
	| { kind: 'rate_limited'; retryAfterSeconds: number }

export type DeviceDecisionResult =
	| { kind: 'approved' | 'denied'; account?: true }
	| {
			kind:
				| 'invalid_code'
				| 'not_found'
				| 'email_unverified'
				/** Full-account approval needs its explicit confirmation. */
				| 'confirm_required'
	  }
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
	const admitted =
		row &&
		(row.kind === 'package_app' ||
			row.kind === 'account' ||
			deviceGrantClientIds(appOrigin).includes(row.client_id))
	if (!row || !admitted) {
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
	if (row.kind === 'package_app') {
		return { kind: 'package_app', userCode: formatUserCode(row.user_code) }
	}
	if (row.kind === 'account') {
		return {
			kind: 'account',
			request: describeAccountDeviceRequest({
				row,
				approverRequest: input.request,
			}),
		}
	}
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
	/** The approver ticked "I am signing a browser in to my full account". */
	confirmFullAccount?: boolean
}): Promise<DeviceDecisionResult> {
	const found = await findPendingForPerson(input)
	if (found.kind !== 'found') return found
	const { row } = found
	if (row.kind === 'account') {
		return decideAccountDeviceSignIn({ ...input, row })
	}
	// Package-app visitor sign-ins are decided on the app's consent page.
	if (row.kind !== 'cli') return { kind: 'not_found' }
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

/**
 * Approve or deny a full-account sign-in (ADR 0094). Approving needs the
 * explicit confirmation, a verified email, and a slot in the per-person
 * approval limit, and always emails the account.
 */
async function decideAccountDeviceSignIn(input: {
	request: Request
	env: Env
	user: DeviceVerificationUser
	decision: 'approve' | 'deny'
	confirmFullAccount?: boolean
	row: DeviceAuthorizationRow
}): Promise<DeviceDecisionResult> {
	const { env, row } = input
	const personId = personIdFromStored(input.user.personId)
	const ip = getRequestIp(input.request) ?? undefined
	const audit = (result: 'success' | 'failure', reason?: string) =>
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'account_device_verify',
			result,
			email: input.user.email,
			ip,
			...(reason ? { reason } : {}),
		})
	if (input.decision === 'deny') {
		const denied = await decideAccountDeviceAuthorization(env.APP_DB, {
			id: row.id,
			decision: 'denied',
			userId: personId,
		})
		audit('success', 'denied')
		return denied ? { kind: 'denied', account: true } : { kind: 'not_found' }
	}
	if (input.confirmFullAccount !== true) return { kind: 'confirm_required' }
	const verified = await isAccountEmailVerified({
		db: env.APP_DB,
		email: input.user.email,
		stableUserId: personId,
	})
	if (!verified) return { kind: 'email_unverified' }
	const limit = await checkRateLimit(
		env.APP_DB,
		`oauth-device:account-approve:person:${personId}`,
		accountDeviceApproveRateLimit,
	)
	if (!limit.allowed) {
		audit('failure', 'rate_limited')
		return {
			kind: 'rate_limited',
			retryAfterSeconds: limit.retryAfterSeconds ?? 60,
		}
	}
	const approved = await decideAccountDeviceAuthorization(env.APP_DB, {
		id: row.id,
		decision: 'approved',
		userId: personId,
	})
	audit(approved ? 'success' : 'failure', approved ? undefined : 'not_pending')
	if (!approved) return { kind: 'not_found' }
	waitUntil(
		notifyAccountDeviceSignInApproved({
			env,
			requestUrl: input.request.url,
			email: input.user.email,
			row,
		}),
	)
	return { kind: 'approved', account: true }
}

/**
 * A pending package-app visitor sign-in (ADR 0094) by the code the visitor
 * typed or scanned, under the same per-person and per-IP code-entry limits as
 * `/device`.
 */
export async function findPendingPackageAppDeviceAuthorization(input: {
	request: Request
	env: Env
	user: DeviceVerificationUser
	userCode: string | null
}): Promise<
	| { kind: 'found'; row: DeviceAuthorizationRow }
	| { kind: 'invalid_code' | 'not_found' }
	| { kind: 'rate_limited'; retryAfterSeconds: number }
> {
	const found = await findPendingForPerson(input)
	if (found.kind !== 'found') return found
	return found.row.kind === 'package_app' ? found : { kind: 'not_found' }
}
