import { adminOperationResult } from './operation-result.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
	redactEmailRecipient,
} from '#worker/audit-log.ts'
import {
	adminCreateUserWithPasswordSetup,
	AdminCreateUserError,
} from '#worker/identity/admin-user-creation.ts'
import { scheduleUserCreatedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import {
	clearAdminUserEmailOutboundPause,
	loadAdminUserByTarget,
	loadAdminUserRowByStableUserId,
	loadRolesByUserIds,
	updateAdminUserPlan,
	updateAdminUserSuspension,
} from '#worker/admin/users-data.ts'
import {
	AdminEmailVerificationError,
	markAdminUserEmailVerified,
	mintAdminEmailVerificationUrl,
} from '#worker/identity/email-verification-admin.ts'
import {
	AdminEmailDestinationVerificationError,
	markAdminEmailDestinationVerified,
} from '#worker/email/destination-verification-admin.ts'
import {
	parsePlanName,
	resolvePlanWrite,
	type PlanName,
} from '#universal/plans.ts'
import {
	assignUserRole,
	removeAdminRolePreservingLastAdmin,
	removeUserRole,
	requireUserWithPermission,
} from '#app/permissions-server.ts'
import { type RoleName, roleNames } from '#universal/permissions.ts'
import { readNonEmptyTrimmedStringOrNumber } from '#app/request-body.ts'
import { parsePersonId } from '@kody-internal/shared/owner-person-ids.ts'

export {
	adminUserListItemFieldNames,
	type AdminUserListItem,
} from '#worker/admin/users-data.ts'

export async function assignAdminUserRole(input: {
	env: Env
	request: Request
	stableUserId?: unknown
	role?: unknown
}) {
	const actor = await requireUserWithPermission(
		input.request,
		input.env,
		'update:user:any',
	)
	const targetStableUserId = readStableUserIdField(input)
	const roleName = readRoleName(input, 'role')
	if (!targetStableUserId) {
		return adminOperationResult(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}
	if (!roleName) {
		return adminOperationResult({ ok: false, error: 'Role is required.' }, 400)
	}

	const targetUser = await loadAdminUserRowByStableUserId(
		input.env.APP_DB,
		targetStableUserId,
	)
	if (!targetUser) {
		return adminOperationResult({ ok: false, error: 'User not found.' }, 404)
	}

	await assignUserRole({
		db: input.env.APP_DB,
		userId: targetUser.id,
		roleName,
	})

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'assign_role',
		result: 'success',
		email: actor.email,
		ip: requestIp,
		path: '/admin/users',
		reason: `target_stable_user_id=${targetStableUserId};role=${roleName}`,
	})

	return buildMutationResponse(input.env, targetStableUserId)
}

/** Return the changed resource, leaving list refreshes to the query owner. */
async function buildMutationResponse(
	env: Env,
	targetStableUserId: string,
	extra: { verifyUrl?: string | null; verifyUrlExpiresAt?: number | null } = {},
) {
	const updatedUser = await loadAdminUserByTarget(env.APP_DB, {
		stableUserId: targetStableUserId,
	})
	return adminOperationResult({ ok: true as const, updatedUser, ...extra })
}

export async function removeAdminUserRole(input: {
	env: Env
	request: Request
	stableUserId?: unknown
	role?: unknown
}) {
	const actor = await requireUserWithPermission(
		input.request,
		input.env,
		'update:user:any',
	)
	const targetStableUserId = readStableUserIdField(input)
	const roleName = readRoleName(input, 'role')
	if (!targetStableUserId) {
		return adminOperationResult(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}
	if (!roleName) {
		return adminOperationResult({ ok: false, error: 'Role is required.' }, 400)
	}

	const targetUser = await loadAdminUserRowByStableUserId(
		input.env.APP_DB,
		targetStableUserId,
	)
	if (!targetUser) {
		return adminOperationResult({ ok: false, error: 'User not found.' }, 404)
	}

	if (roleName === 'admin') {
		// The last-admin check runs inside the DELETE statement itself so two
		// concurrent removals cannot both pass a stale count and leave the
		// deployment with zero admins.
		const { removed } = await removeAdminRolePreservingLastAdmin({
			db: input.env.APP_DB,
			userId: targetUser.id,
		})
		if (!removed) {
			const targetRoles = await loadRolesByUserIds(input.env.APP_DB, [
				targetUser.id,
			])
			const targetStillAdmin = (targetRoles.get(targetUser.id) ?? []).includes(
				'admin',
			)
			if (targetStillAdmin) {
				const requestIp = getRequestIp(input.request) ?? undefined
				void logAuditEvent({
					db: auditDatabaseFromEnv(input.env),
					category: 'admin',
					action: 'remove_role',
					result: 'failure',
					email: actor.email,
					ip: requestIp,
					path: '/admin/users',
					reason: 'last_admin',
				})
				return adminOperationResult(
					{
						ok: false,
						error:
							'Cannot remove the admin role from the last remaining admin account.',
					},
					409,
				)
			}
			// The target did not have the admin role; removal is an idempotent
			// no-op, matching non-admin role removal behavior.
		}
	} else {
		await removeUserRole({
			db: input.env.APP_DB,
			userId: targetUser.id,
			roleName,
		})
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'remove_role',
		result: 'success',
		email: actor.email,
		ip: requestIp,
		path: '/admin/users',
		reason: `target_stable_user_id=${targetStableUserId};role=${roleName}`,
	})

	return buildMutationResponse(input.env, targetStableUserId)
}

export async function setAdminUserPlan(input: {
	env: Env
	request: Request
	stableUserId?: unknown
	plan?: unknown
}) {
	const actor = await requireUserWithPermission(
		input.request,
		input.env,
		'update:user:any',
	)
	const targetStableUserId = readStableUserIdField(input)
	if (!targetStableUserId) {
		return adminOperationResult(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}
	const planUpdate = readPlanUpdate(input)
	if (!planUpdate.ok) {
		return adminOperationResult(
			{
				ok: false,
				error: 'Plan must be one of the known plan names, or null for free.',
			},
			400,
		)
	}

	const updatedUser = await updateAdminUserPlan(input.env.APP_DB, {
		stableUserId: targetStableUserId,
		plan: planUpdate.plan,
	})
	if (!updatedUser) {
		return adminOperationResult({ ok: false, error: 'User not found.' }, 404)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'update_plan',
		result: 'success',
		email: actor.email,
		ip: requestIp,
		path: '/admin/users',
		reason: `target_stable_user_id=${targetStableUserId};plan=${planUpdate.plan}`,
	})

	return buildMutationResponse(input.env, targetStableUserId)
}

/**
 * Set or clear the platform suspension. Unlike a community ban (community
 * surfaces only), suspension is fail-closed at the browser-session, MCP,
 * and email chokepoints.
 */
export async function setAdminUserSuspension(input: {
	env: Env
	request: Request
	stableUserId?: unknown
	suspended: boolean
}) {
	const actor = await requireUserWithPermission(
		input.request,
		input.env,
		'update:user:any',
	)
	const targetStableUserId = readStableUserIdField(input)
	if (!targetStableUserId) {
		return adminOperationResult(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}
	if (input.suspended && targetStableUserId === actor.mcpUser.userId) {
		return adminOperationResult(
			{ ok: false, error: 'You cannot suspend your own account.' },
			400,
		)
	}

	const updatedUser = await updateAdminUserSuspension(input.env.APP_DB, {
		stableUserId: targetStableUserId,
		suspended: input.suspended,
	})
	if (!updatedUser) {
		return adminOperationResult({ ok: false, error: 'User not found.' }, 404)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: input.suspended ? 'suspend_user' : 'unsuspend_user',
		result: 'success',
		email: actor.email,
		ip: requestIp,
		path: '/admin/users',
		reason: `target_stable_user_id=${targetStableUserId}`,
	})

	return buildMutationResponse(input.env, targetStableUserId)
}

/**
 * Clear an automatic outbound-email pause (set by the delivery-event
 * abuse monitor) after reviewing the account's delivery history.
 */
export async function resumeAdminUserEmail(input: {
	env: Env
	request: Request
	stableUserId?: unknown
}) {
	const actor = await requireUserWithPermission(
		input.request,
		input.env,
		'update:user:any',
	)
	const targetStableUserId = readStableUserIdField(input)
	if (!targetStableUserId) {
		return adminOperationResult(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}

	const updatedUser = await clearAdminUserEmailOutboundPause(input.env.APP_DB, {
		stableUserId: targetStableUserId,
	})
	if (!updatedUser) {
		return adminOperationResult({ ok: false, error: 'User not found.' }, 404)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'resume_email_outbound',
		result: 'success',
		email: actor.email,
		ip: requestIp,
		path: '/admin/users',
		reason: `target_stable_user_id=${targetStableUserId}`,
	})

	return buildMutationResponse(input.env, targetStableUserId)
}

export async function verifyAdminUserEmail(input: {
	env: Env
	request: Request
	stableUserId?: unknown
}) {
	const actor = await requireUserWithPermission(
		input.request,
		input.env,
		'update:user:any',
	)
	const targetStableUserId = readStableUserIdField(input)
	if (!targetStableUserId) {
		return adminOperationResult(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}

	try {
		await markAdminUserEmailVerified(input.env.APP_DB, {
			stableUserId: targetStableUserId,
		})
	} catch (error) {
		if (
			error instanceof AdminEmailVerificationError &&
			error.code === 'not_found'
		) {
			return adminOperationResult({ ok: false, error: 'User not found.' }, 404)
		}
		throw error
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'mark_email_verified',
		result: 'success',
		email: actor.email,
		ip: requestIp,
		path: '/admin/users',
		reason: `target_stable_user_id=${targetStableUserId}`,
	})

	return buildMutationResponse(input.env, targetStableUserId)
}

export async function mintAdminUserVerificationUrl(input: {
	env: Env
	request: Request
	stableUserId?: unknown
}) {
	const actor = await requireUserWithPermission(
		input.request,
		input.env,
		'update:user:any',
	)
	const targetStableUserId = readStableUserIdField(input)
	if (!targetStableUserId) {
		return adminOperationResult(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}

	let minted: Awaited<ReturnType<typeof mintAdminEmailVerificationUrl>>
	try {
		minted = await mintAdminEmailVerificationUrl({
			db: input.env.APP_DB,
			appBaseUrl: new URL(input.request.url).origin,
			target: { stableUserId: targetStableUserId },
		})
	} catch (error) {
		if (error instanceof AdminEmailVerificationError) {
			return adminOperationResult(
				{ ok: false, error: error.message },
				error.code === 'not_found' ? 404 : 400,
			)
		}
		throw error
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'mint_verify_url',
		result: 'success',
		email: actor.email,
		ip: requestIp,
		path: '/admin/users',
		reason: `target_stable_user_id=${targetStableUserId}`,
	})

	return buildMutationResponse(input.env, targetStableUserId, {
		verifyUrl: minted.verifyUrl,
		verifyUrlExpiresAt: minted.expiresAt,
	})
}

export async function verifyAdminUserEmailDestination(input: {
	env: Env
	request: Request
	stableUserId?: unknown
	destinationEmail?: unknown
}) {
	const actor = await requireUserWithPermission(
		input.request,
		input.env,
		'update:user:any',
	)
	const targetStableUserId = readStableUserIdField(input)
	if (!targetStableUserId) {
		return adminOperationResult(
			{ ok: false, error: 'Stable user id is required.' },
			400,
		)
	}
	const destinationEmail =
		readNonEmptyTrimmedStringOrNumber(input, 'destinationEmail') ?? ''
	if (!destinationEmail) {
		return adminOperationResult(
			{ ok: false, error: 'Destination email is required.' },
			400,
		)
	}

	let marked: Awaited<ReturnType<typeof markAdminEmailDestinationVerified>>
	try {
		marked = await markAdminEmailDestinationVerified({
			db: input.env.APP_DB,
			target: { stableUserId: targetStableUserId },
			destinationEmail,
		})
	} catch (error) {
		if (error instanceof AdminEmailDestinationVerificationError) {
			return adminOperationResult(
				{ ok: false, error: error.message },
				error.code === 'not_found' ? 404 : 400,
			)
		}
		throw error
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'mark_email_destination_verified',
		result: 'success',
		email: actor.email,
		ip: requestIp,
		path: '/admin/users',
		reason: `target_stable_user_id=${targetStableUserId};destination=${marked.destination.email}`,
	})

	return buildMutationResponse(input.env, targetStableUserId)
}

export async function createAdminUser(input: {
	env: Env
	request: Request
	email?: unknown
	username?: unknown
}) {
	const actor = await requireUserWithPermission(
		input.request,
		input.env,
		'update:user:any',
	)
	const email = readNonEmptyTrimmedStringOrNumber(input, 'email') ?? ''
	const username = readNonEmptyTrimmedStringOrNumber(input, 'username')

	try {
		const createdUser = await adminCreateUserWithPasswordSetup({
			db: input.env.APP_DB,
			env: input.env,
			email,
			username,
			setupLinkOrigin: new URL(input.request.url),
		})
		scheduleUserCreatedEvent({
			env: input.env,
			user: {
				id: createdUser.stableUserId,
				username: createdUser.username,
				email: createdUser.email,
			},
			source: 'admin',
		})
		const requestIp = getRequestIp(input.request) ?? undefined
		void logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'admin',
			action: 'create_user',
			result: 'success',
			email: actor.email,
			ip: requestIp,
			path: '/admin/users',
			reason: [
				`actor_stable_user_id=${actor.mcpUser.userId}`,
				`target_stable_user_id=${createdUser.stableUserId}`,
				`target_email=${redactEmailRecipient(createdUser.email)}`,
			].join(';'),
		})

		const { userId: _userId, ...boundaryUser } = createdUser
		return adminOperationResult({
			ok: true as const,
			createdUser: boundaryUser,
		})
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Unable to create user.'
		const requestIp = getRequestIp(input.request) ?? undefined
		void logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'admin',
			action: 'create_user',
			result: 'failure',
			email: actor.email,
			ip: requestIp,
			path: '/admin/users',
			reason:
				error instanceof AdminCreateUserError ? error.code : 'create_failed',
		})
		return adminOperationResult(
			{
				ok: false,
				error: message,
				code: error instanceof AdminCreateUserError ? error.code : undefined,
			},
			error instanceof AdminCreateUserError &&
				(error.code === 'email_exists' || error.code === 'username_exists')
				? 409
				: error instanceof AdminCreateUserError
					? 400
					: 500,
		)
	}
}

/**
 * Read the requested plan value: a known plan name sets it; explicit null
 * (and empty string) map to `free` (the normal default). Writers never
 * persist NULL. Missing key or unknown plan strings are rejected.
 */
function readPlanUpdate(
	body: object,
): { ok: true; plan: PlanName } | { ok: false } {
	if (!('plan' in body)) return { ok: false }
	const value = (body as Record<string, unknown>).plan
	if (value === null) return { ok: true, plan: resolvePlanWrite(null) }
	if (typeof value === 'string') {
		const trimmed = value.trim()
		if (!trimmed) return { ok: true, plan: resolvePlanWrite(null) }
		const plan = parsePlanName(trimmed)
		if (plan) return { ok: true, plan }
	}
	return { ok: false }
}

function isRoleName(value: string): value is RoleName {
	return (roleNames as ReadonlyArray<string>).includes(value)
}

function readRoleName(body: object, key: string): RoleName | null {
	const value = readNonEmptyTrimmedStringOrNumber(body, key)
	return value && isRoleName(value) ? value : null
}

function readStableUserIdField(body: object): string | null {
	return parsePersonId((body as Record<string, unknown>).stableUserId)
}
