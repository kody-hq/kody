import type { AuthenticatedAppUser } from '#worker/app/authenticated-user.ts'
import { parseOwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getOrgById } from '#worker/orgs/repo.ts'
import { logAuditEvent } from '#worker/audit-log.ts'
import {
	orgAuditWriterFromRequest,
	runAppDbBatchWithOrgAudit,
} from '#worker/orgs/org-audit.ts'
import { readFileStorageQuota } from '#worker/files/quota.ts'
import {
	normalizeOrgLimitOverrideReason,
	orgLimitOverrideAuditActions,
} from './org-limit-overrides.ts'

async function liveOrgId(db: D1Database, value: string) {
	const orgId = parseOwnerId(value)
	if (!orgId || !(await getOrgById(db, orgId)))
		throw new Error('Organization not found.')
	return orgId
}

export async function readAdminFileQuota(env: Env, target?: string) {
	const orgId = target ? await liveOrgId(env.APP_DB, target) : undefined
	return readFileStorageQuota(
		env.APP_DB,
		Number(env.FILES_INCLUDED_BYTES ?? 0),
		orgId,
	)
}

export async function updateAdminFileQuota({
	env,
	actor,
	orgId: target,
	bytes,
	reason: rawReason,
}: {
	env: Env
	actor: AuthenticatedAppUser
	orgId?: string
	bytes: number | null
	reason: string
}) {
	const db = env.APP_DB
	const reason = normalizeOrgLimitOverrideReason(rawReason)
	const fallback = Number(env.FILES_INCLUDED_BYTES ?? 0)
	const orgId = target ? await liveOrgId(db, target) : undefined
	if (orgId) {
		const { overrideBytes: previous } = await readFileStorageQuota(
			db,
			fallback,
			orgId,
		)
		const statement =
			bytes === null
				? db
						.prepare(
							'DELETE FROM file_storage_quota_overrides WHERE org_id = ?',
						)
						.bind(orgId)
				: db
						.prepare(`INSERT INTO file_storage_quota_overrides (org_id, included_bytes)
				VALUES (?, ?) ON CONFLICT (org_id) DO UPDATE SET included_bytes = excluded.included_bytes
				WHERE included_bytes != excluded.included_bytes`)
						.bind(orgId, bytes)
		await runAppDbBatchWithOrgAudit({
			appDb: db,
			audit: orgAuditWriterFromRequest(env, actor.request),
			statements: [statement],
			onlyIfChanged: true,
			event: {
				orgId,
				action:
					bytes === null
						? orgLimitOverrideAuditActions.removed
						: previous === null
							? orgLimitOverrideAuditActions.set
							: orgLimitOverrideAuditActions.changed,
				resourceType: 'limit_override',
				resourceId: 'file_storage_bytes',
				details: { previous, next: bytes, reason },
			},
		})
	} else {
		if (bytes === null) throw new Error('Enter a default quota.')
		const { meta } = await db
			.prepare(`INSERT INTO file_storage_default_quota (id, included_bytes)
			VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET included_bytes = excluded.included_bytes
			WHERE included_bytes != excluded.included_bytes`)
			.bind(bytes)
			.run()
		if (meta.changes) {
			await logAuditEvent({
				db: env.AUDIT_DB,
				category: 'admin',
				action: 'file_storage_default_quota_changed',
				result: 'success',
				email: actor.email,
				path: '/admin/orgs',
				reason: JSON.stringify({ bytes, reason }),
			})
		}
	}
	return readFileStorageQuota(db, fallback, orgId)
}
