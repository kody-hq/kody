import {
	type SetGlobalFeatureFlagInput,
	type SetFeatureFlagOverrideInput,
	type ClearFeatureFlagOverrideInput,
} from '#universal/admin-setting-mutations.ts'
import { adminOperationResult } from './operation-result.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { isFeatureFlagKey } from '#universal/feature-flags/registry.ts'
import {
	clearFeatureFlagUserOverride,
	deleteStaleFeatureFlag,
	setFeatureFlagGlobalState,
	setFeatureFlagUserOverride,
} from '#worker/feature-flags/service.ts'
import { parsePersonId } from '@kody-internal/shared/owner-person-ids.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export async function setAdminGlobalFeatureFlag(input: {
	env: Env
	request: Request
	fields: SetGlobalFeatureFlagInput
}) {
	const actor = await requireUserWithRole(input.request, input.env, 'admin')
	const key = input.fields.key.trim()
	if (!key || !isFeatureFlagKey(key)) {
		return adminOperationResult(
			{ ok: false, error: 'Unknown or invalid feature flag key.' },
			400,
		)
	}

	const enabled = input.fields.enabled
	if (typeof enabled !== 'boolean') {
		return adminOperationResult(
			{ ok: false, error: 'enabled must be a boolean.' },
			400,
		)
	}

	const rolloutPercent = input.fields.rolloutPercent ?? null
	if (
		rolloutPercent !== null &&
		(!Number.isInteger(rolloutPercent) ||
			rolloutPercent < 0 ||
			rolloutPercent > 100)
	) {
		return adminOperationResult(
			{
				ok: false,
				error: 'rolloutPercent must be an integer between 0 and 100, or null.',
			},
			400,
		)
	}

	const fields = input.fields

	try {
		await setFeatureFlagGlobalState(input.env.APP_DB, {
			key,
			enabled,
			rolloutPercent,
			...(Object.hasOwn(fields, 'note') ? { note: fields.note } : {}),
			...(Object.hasOwn(fields, 'audience')
				? { audience: fields.audience }
				: {}),
			updatedBy: actor.userId,
		})
	} catch (error) {
		return adminOperationResult(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to update feature flag.',
			},
			400,
		)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'feature_flag_set_global',
		result: 'success',
		email: actor.email,
		ip: requestIp,
		path: '/admin/feature-flags',
		reason: [
			`key=${key}`,
			`enabled=${enabled}`,
			`rollout_percent=${rolloutPercent === null ? 'null' : String(rolloutPercent)}`,
			Object.hasOwn(fields, 'audience')
				? `audience=${String(fields.audience)}`
				: null,
		]
			.filter((part) => part !== null)
			.join(';'),
	})

	return adminOperationResult({ ok: true as const })
}

export async function setAdminFeatureFlagOverride(input: {
	env: Env
	request: Request
	fields: SetFeatureFlagOverrideInput
}) {
	const actor = await requireUserWithRole(input.request, input.env, 'admin')
	const key = input.fields.key.trim()
	if (!key || !isFeatureFlagKey(key)) {
		return adminOperationResult(
			{ ok: false, error: 'Unknown or invalid feature flag key.' },
			400,
		)
	}

	const enabled = input.fields.enabled
	if (typeof enabled !== 'boolean') {
		return adminOperationResult(
			{ ok: false, error: 'enabled must be a boolean.' },
			400,
		)
	}

	const resolvedUserId = await resolveOverrideUserId(
		input.env.APP_DB,
		input.fields,
	)
	if (resolvedUserId.status === 'invalid') {
		return adminOperationResult({ ok: false, error: resolvedUserId.error }, 400)
	}
	if (resolvedUserId.status === 'not_found') {
		return adminOperationResult({ ok: false, error: 'User not found.' }, 404)
	}
	const targetUserId = resolvedUserId.dbUserId
	const targetStableUserId = resolvedUserId.stableUserId

	await setFeatureFlagUserOverride(input.env.APP_DB, {
		key,
		userId: targetUserId,
		enabled,
		updatedBy: actor.userId,
	})

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'feature_flag_set_user_override',
		result: 'success',
		email: actor.email,
		ip: requestIp,
		path: '/admin/feature-flags',
		reason: [
			`key=${key}`,
			`target_stable_user_id=${targetStableUserId}`,
			`enabled=${enabled}`,
		].join(';'),
	})

	return adminOperationResult({ ok: true as const })
}

export async function clearAdminFeatureFlagOverride(input: {
	env: Env
	request: Request
	fields: ClearFeatureFlagOverrideInput
}) {
	const actor = await requireUserWithRole(input.request, input.env, 'admin')
	const key = input.fields.key.trim()
	if (!key || !isFeatureFlagKey(key)) {
		return adminOperationResult(
			{ ok: false, error: 'Unknown or invalid feature flag key.' },
			400,
		)
	}

	const resolvedUserId = await resolveOverrideUserId(
		input.env.APP_DB,
		input.fields,
	)
	if (resolvedUserId.status === 'invalid') {
		return adminOperationResult({ ok: false, error: resolvedUserId.error }, 400)
	}
	if (resolvedUserId.status === 'not_found') {
		return adminOperationResult({ ok: false, error: 'User not found.' }, 404)
	}

	const cleared = await clearFeatureFlagUserOverride(input.env.APP_DB, {
		key,
		userId: resolvedUserId.dbUserId,
	})
	if (!cleared) {
		return adminOperationResult(
			{ ok: false, error: 'User override not found.' },
			404,
		)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'feature_flag_clear_user_override',
		result: 'success',
		email: actor.email,
		ip: requestIp,
		path: '/admin/feature-flags',
		reason: [
			`key=${key}`,
			`target_stable_user_id=${resolvedUserId.stableUserId}`,
		].join(';'),
	})

	return adminOperationResult({ ok: true as const })
}

export async function deleteAdminStaleFeatureFlag(input: {
	env: Env
	request: Request
	fields: { key: string }
}) {
	const actor = await requireUserWithRole(input.request, input.env, 'admin')
	const key = input.fields.key.trim()
	if (!key) {
		return adminOperationResult(
			{ ok: false, error: 'Feature flag key is required.' },
			400,
		)
	}

	try {
		const deleted = await deleteStaleFeatureFlag(input.env.APP_DB, key)
		if (!deleted) {
			return adminOperationResult(
				{ ok: false, error: 'Stale feature flag not found.' },
				404,
			)
		}
	} catch (error) {
		return adminOperationResult(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to delete feature flag.',
			},
			400,
		)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'feature_flag_delete_stale',
		result: 'success',
		email: actor.email,
		ip: requestIp,
		path: '/admin/feature-flags',
		reason: `key=${key}`,
	})

	return adminOperationResult({ ok: true as const })
}

type ResolveOverrideUserIdResult =
	| { status: 'ok'; dbUserId: number; stableUserId: string }
	| { status: 'invalid'; error: string }
	| { status: 'not_found' }

async function resolveOverrideUserId(
	db: D1Database,
	fields: ClearFeatureFlagOverrideInput,
): Promise<ResolveOverrideUserIdResult> {
	const record = fields
	const stableUserId = parsePersonId(fields.stableUserId)
	const hasStableUserId =
		Object.hasOwn(record, 'stableUserId') && record.stableUserId != null
	const username = fields.username?.trim() || null
	const hasUsername = username !== null

	if (!hasStableUserId && !hasUsername) {
		return {
			status: 'invalid',
			error: 'Provide either stableUserId or username.',
		}
	}
	if (hasStableUserId && hasUsername) {
		return {
			status: 'invalid',
			error: 'Provide either stableUserId or username, not both.',
		}
	}

	if (hasStableUserId) {
		if (stableUserId === null) {
			return {
				status: 'invalid',
				error: 'stableUserId must be a valid stable user id.',
			}
		}
		const row = await db
			.prepare(
				`SELECT id, stable_user_id FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(stableUserId)
			.first<{ id: number; stable_user_id: string }>()
		if (!row) {
			return { status: 'not_found' }
		}
		return {
			status: 'ok',
			dbUserId: row.id,
			stableUserId: row.stable_user_id,
		}
	}

	if (!username) {
		return {
			status: 'invalid',
			error: 'Provide either stableUserId or username.',
		}
	}
	const row = await db
		.prepare(
			`SELECT id, stable_user_id FROM users WHERE username = ?${andLiveDeletedAtSql()}`,
		)
		.bind(username)
		.first<{ id: number; stable_user_id: string }>()
	if (!row) {
		return { status: 'not_found' }
	}
	return {
		status: 'ok',
		dbUserId: row.id,
		stableUserId: row.stable_user_id,
	}
}
