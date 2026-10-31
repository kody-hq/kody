import * as Sentry from '@sentry/cloudflare'
/**
 * Org audit rows for credential writes that had none: create, value replace,
 * delete, disconnect, rename, allowed packages, and plain detail edits, for
 * every credential kind (Keys, OAuth connections, MCP servers, vault
 * bindings). Opt-in field, host, and personal grant writes keep their own
 * actions.
 *
 * Every write function that changes an org credential takes an
 * `OrgAuditWriter | null` so a new write path cannot skip the audit without
 * a type error. `null` is for callers with no org actor (tests, migrations).
 *
 * Details carry names and field names only, never credential values.
 */
import {
	credentialPermissionFamily,
	type CredentialKind,
} from './credential-ids.ts'
import { grantCreatorAccess } from '#worker/orgs/creator-access.ts'
import {
	recordOrgAuditEvent,
	type OrgAuditOutboxEvent,
	type OrgAuditWriter,
} from '#worker/orgs/org-audit.ts'

export const credentialAuditActions = {
	created: 'credential.created',
	valueReplaced: 'credential.value_replaced',
	deleted: 'credential.deleted',
	disconnected: 'credential.disconnected',
	renamed: 'credential.renamed',
	allowedPackagesUpdated: 'credential.allowed_packages_updated',
	hostsUpdated: 'credential.hosts_updated',
	detailsUpdated: 'credential.details_updated',
	enabledChanged: 'credential.enabled_changed',
} as const

export type CredentialAuditAction =
	(typeof credentialAuditActions)[keyof typeof credentialAuditActions]

/** Plain credential fields a detail edit can change. */
export type CredentialDetailField =
	| 'description'
	| 'expires_at'
	| 'scopes'
	| 'account_label'
	| 'hosts'
	| 'config'

export type CredentialAuditChange = {
	orgId: string
	credential: { id: string; kind: CredentialKind; name: string }
	action: CredentialAuditAction
	/** Extra audit details. Never a credential value or token. */
	details?: Record<string, unknown>
}

export function credentialAuditEvent(
	change: CredentialAuditChange,
): OrgAuditOutboxEvent {
	return {
		orgId: change.orgId,
		action: change.action,
		resourceType: 'credential',
		resourceId: change.credential.id,
		details: {
			...change.details,
			credentialKind: change.credential.kind,
			name: change.credential.name,
		},
	}
}

/**
 * Records credential changes after their APP_DB write committed (the
 * transitional outbox path). A null writer records nothing.
 */
export async function recordCredentialAudit(
	writer: OrgAuditWriter | null,
	changes: CredentialAuditChange | ReadonlyArray<CredentialAuditChange>,
) {
	if (!writer) return
	const list: ReadonlyArray<CredentialAuditChange> = Array.isArray(changes)
		? changes
		: [changes as CredentialAuditChange]
	for (const change of list) {
		await recordOrgAuditEvent(writer, credentialAuditEvent(change))
	}
	// Every credential create is audited here, so this is where its creator
	// gets access. Vault bindings are org-wide configuration, never granted.
	for (const change of list) {
		if (change.action !== credentialAuditActions.created) continue
		if (change.credential.kind === 'vault' || !writer.env) continue
		// The credential is stored; adminCreatorAccessBackfill repairs a
		// missed grant, so it must not fail the create.
		await grantCreatorAccess({
			env: writer.env,
			orgId: change.orgId,
			creatorUserId: writer.actorUserId,
			creatorProfileId: writer.actorProfileId ?? null,
			audit: writer,
			resources: [
				{
					resourceType: 'credential',
					resourceId: change.credential.id,
					family: credentialPermissionFamily(change.credential.kind),
				},
			],
		}).catch((error: unknown) => {
			Sentry.captureException(error, {
				tags: { context: 'credential-creator-grant' },
			})
		})
	}
}

/** Sorted, de-duplicated list comparison for allowed package and host lists. */
export function sameStringSet(
	left: ReadonlyArray<string>,
	right: ReadonlyArray<string>,
) {
	const a = [...new Set(left)].sort()
	const b = [...new Set(right)].sort()
	return a.length === b.length && a.every((value, index) => value === b[index])
}

/** Added and removed entries between two lists, for audit details. */
export function listDelta(
	before: ReadonlyArray<string>,
	after: ReadonlyArray<string>,
) {
	const beforeSet = new Set(before)
	const afterSet = new Set(after)
	return {
		added: [...afterSet].filter((value) => !beforeSet.has(value)).sort(),
		removed: [...beforeSet].filter((value) => !afterSet.has(value)).sort(),
	}
}

/**
 * Audit change for an allowed packages edit on a credential with a usage
 * mode (OAuth connections and MCP servers). Null when nothing changed.
 */
export function allowedPackagesAuditChange(input: {
	orgId: string
	credential: CredentialAuditChange['credential']
	before: { usageMode: string; allowedPackageIds: ReadonlyArray<string> }
	after: { usageMode: string; allowedPackageIds: ReadonlyArray<string> }
}): CredentialAuditChange | null {
	const fields: Array<'usage_mode' | 'allowed_packages'> = []
	if (input.before.usageMode !== input.after.usageMode)
		fields.push('usage_mode')
	if (
		!sameStringSet(
			input.before.allowedPackageIds,
			input.after.allowedPackageIds,
		)
	) {
		fields.push('allowed_packages')
	}
	if (fields.length === 0) return null
	return {
		orgId: input.orgId,
		credential: input.credential,
		action: credentialAuditActions.allowedPackagesUpdated,
		details: {
			usageMode: {
				before: input.before.usageMode,
				after: input.after.usageMode,
			},
			packages: listDelta(
				input.before.allowedPackageIds,
				input.after.allowedPackageIds,
			),
			fields,
		},
	}
}
