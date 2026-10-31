import { waitUntil } from 'cloudflare:workers'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { auditDatabaseFromEnv } from '#worker/audit-log.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { IntegrationPackageAccessDeniedError } from '#worker/integrations/package-access.ts'
import { McpServerPackageAccessDeniedError } from '#worker/mcp-client/package-access.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'
import { IntegrationHostNotAllowedError } from '#mcp/execute-modules/integration-host-allowlist.ts'
import { SecretHostNotApprovedError } from '#mcp/secrets/errors.ts'
import { PackageSecretAccessDeniedError } from '#mcp/secrets/package-access.ts'
import {
	SecretProviderGrantDeniedError,
	SecretProviderHostDeniedError,
} from '#mcp/secrets/secret-providers/errors.ts'
import {
	CredentialNotFoundError,
	CredentialRequestRefusedError,
} from './credential-request.ts'
import { CredentialNeedUndeclaredError } from './credential-need-enforcement.ts'
import { type PackageStamp } from './package-stamp.ts'
import { reportOrgAuditWriteFailure } from './report-org-audit-write-failure.ts'

export const credentialResolveAuditAction = 'credential.resolve'

/**
 * Which credential a resolution is for. The row's resource id is the stable
 * credential id once the door finds the credential (null when it does not);
 * the name the caller asked for goes in the details. Fetch uses record
 * `details.host`, the host the value is sent to, so a review can compare
 * declared and used hosts. Placeholder fills also record `details.placement`:
 * the lowercase header name, or `url` / `body`. A header named `url` or `body`
 * is `header:url` or `header:body`.
 */
export type CredentialAuditSubject = {
	use: string
	resourceType: 'secret' | 'secret-provider' | 'integration' | 'mcp-server'
	/** Secret, integration, or MCP server name, or vault provider id. */
	name: string
	credentialId: string | null
	details?: Record<string, string | null>
}

export type CredentialResolutionOutcome =
	| { result: 'success' }
	| { result: 'failure' | 'denied'; reason: string }

export function credentialResolutionOutcomeForError(
	error: unknown,
): CredentialResolutionOutcome {
	if (error instanceof AuthorizationError) {
		return { result: 'denied', reason: error.code }
	}
	if (error instanceof CredentialRequestRefusedError) {
		return { result: 'denied', reason: error.code }
	}
	if (error instanceof CredentialNeedUndeclaredError) {
		return { result: 'denied', reason: error.code }
	}
	if (error instanceof CredentialNotFoundError) {
		return { result: 'failure', reason: 'not_found' }
	}
	if (
		error instanceof PackageSecretAccessDeniedError ||
		error instanceof IntegrationPackageAccessDeniedError ||
		error instanceof McpServerPackageAccessDeniedError ||
		error instanceof SecretProviderGrantDeniedError ||
		error instanceof SecretHostNotApprovedError ||
		error instanceof SecretProviderHostDeniedError ||
		error instanceof IntegrationHostNotAllowedError
	) {
		return { result: 'denied', reason: error.name }
	}
	return {
		result: 'failure',
		reason: error instanceof Error ? error.name : 'unknown',
	}
}

function actorKind(actor: RequestContext | null) {
	if (!actor) return 'platform'
	return actor.actor ? 'person' : 'automation'
}

/**
 * One `org_audit_events` row per credential resolution, written after the
 * response path via `waitUntil`. The row names the credential and who asked,
 * never its value. A failed write is logged and reported, never thrown.
 */
export function scheduleCredentialResolutionAudit(input: {
	env: Env
	orgId: OwnerId
	actor: RequestContext | null
	packageStamp: PackageStamp | null | undefined
	subject: CredentialAuditSubject
	outcome: CredentialResolutionOutcome
	/** Run-level details (who viewed an app that used its owner's credential). */
	details?: Record<string, string | null>
}) {
	const db = auditDatabaseFromEnv(input.env)
	// `undefined` is the generic-test opt-out (see `auditDatabaseFromEnv`).
	if (db === undefined) return
	const { subject, outcome } = input
	const request = input.actor
	const event = {
		orgId: input.orgId,
		action: credentialResolveAuditAction,
		resourceType: subject.resourceType,
		resourceId: subject.credentialId,
		result: outcome.result,
	}
	waitUntil(
		(async () => {
			if (!db) throw new Error('AUDIT_DB binding is not configured.')
			await logOrgAuditEvent({
				db,
				...event,
				actorUserId: request?.actor?.userId ?? null,
				actorUsername: request?.actor?.username ?? null,
				credentialKind: request?.credential.kind ?? null,
				credentialId: request?.credential.id ?? null,
				details: {
					use: subject.use,
					name: subject.name,
					actorKind: actorKind(request),
					ownerKind: 'org',
					packageStampKind: input.packageStamp?.kind ?? 'none',
					packageId: input.packageStamp?.packageId ?? null,
					...(outcome.result === 'success' ? {} : { reason: outcome.reason }),
					...input.details,
					...subject.details,
				},
			})
		})().catch((error: unknown) => {
			reportOrgAuditWriteFailure(
				'Failed to record credential resolution audit event:',
				event,
				error,
			)
		}),
	)
}
