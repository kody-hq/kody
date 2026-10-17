/**
 * One `org_audit_events` row per MCP tool invocation, action `mcp.call`.
 *
 * `credential.resolve` stays one row for the connection decision. This row
 * records the tool name, the connection, success or failure, the error
 * class, and how long the call took. It never records arguments, return
 * values, or error messages: those are caller data and would make every
 * tool call a place to leak credentials into the audit log.
 */
import { waitUntil } from 'cloudflare:workers'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { auditDatabaseFromEnv } from '#worker/audit-log.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'
import { type PackageStamp } from './package-stamp.ts'
import { reportOrgAuditWriteFailure } from './report-org-audit-write-failure.ts'

export const mcpCallAuditAction = 'mcp.call'

/** Tool result with `isError: true`. The flag is read; the body is not. */
const mcpToolResultErrorClass = 'McpToolResult'

const errorClassNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const storedErrorClassPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}(?::-?\d{1,6})?$/
const maxErrorCode = 999_999
const maxAuditLabelLength = 128

export type McpCallAuditOutcome =
	| { result: 'success' }
	| { result: 'failure'; errorClass: string }

/**
 * Error class only: the constructor name, plus a small integer code when
 * the thrown value has one (MCP `McpError`). Messages, string codes, and
 * arbitrary `data` stay out — they often echo arguments.
 */
export function mcpCallErrorClass(error: unknown): string {
	if (!(error instanceof Error) || !errorClassNamePattern.test(error.name)) {
		return 'unknown'
	}
	const code = (error as { code?: unknown }).code
	if (
		typeof code === 'number' &&
		Number.isInteger(code) &&
		Math.abs(code) <= maxErrorCode
	) {
		return `${error.name}:${code}`
	}
	return error.name
}

export function mcpCallOutcomeFromResult(result: {
	isError?: boolean
}): McpCallAuditOutcome {
	if (result.isError === true) {
		return { result: 'failure', errorClass: mcpToolResultErrorClass }
	}
	return { result: 'success' }
}

/**
 * Tool names are caller-controlled. Only an identifier is stored. Anything
 * else (an address, a URL, a credential-shaped token, free text) is
 * `redacted` so the name column cannot become a place to leak data.
 */
const toolNameToken = /^[\p{L}\p{N}_.:/-]{1,128}$/u
const sensitiveToolName = /^(?:sk[-_]|kody_(?:at|bc)_|ghp_|xox[abprs]-)|:\/\//i

/** Bound a server name. Control characters are dropped, not stored. */
function mcpCallAuditServerName(value: string): string {
	const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
	if (cleaned.length === 0) return 'unknown'
	return cleaned.length > maxAuditLabelLength
		? cleaned.slice(0, maxAuditLabelLength)
		: cleaned
}

function mcpCallAuditToolName(value: string): string {
	const cleaned = mcpCallAuditServerName(value)
	if (cleaned === 'unknown') return cleaned
	if (!toolNameToken.test(cleaned) || sensitiveToolName.test(cleaned)) {
		return 'redacted'
	}
	return cleaned
}

function storedErrorClass(errorClass: string) {
	return storedErrorClassPattern.test(errorClass) ? errorClass : 'unknown'
}

function actorKind(actor: RequestContext | null) {
	if (!actor) return 'platform'
	return actor.actor ? 'person' : 'automation'
}

/**
 * Written after the call via `waitUntil`. A failed write is logged and
 * reported, never thrown, so the tool result the caller saw still wins.
 */
export function scheduleMcpCallAudit(input: {
	env: Env
	orgId: OwnerId
	actor: RequestContext | null
	packageStamp: PackageStamp | null | undefined
	serverId: string
	serverName: string
	toolName: string
	durationMs: number
	outcome: McpCallAuditOutcome
}) {
	const db = auditDatabaseFromEnv(input.env)
	// `undefined` is the generic-test opt-out (see `auditDatabaseFromEnv`).
	if (db === undefined) return
	const request = input.actor
	const { outcome } = input
	const durationMs = Math.max(0, Math.round(input.durationMs))
	const event = {
		orgId: input.orgId,
		action: mcpCallAuditAction,
		resourceType: 'mcp-server',
		resourceId: input.serverId,
		result: outcome.result,
	}
	const details = {
		use: 'mcp-connection',
		toolName: mcpCallAuditToolName(input.toolName),
		serverName: mcpCallAuditServerName(input.serverName),
		serverId: input.serverId,
		durationMs,
		actorKind: actorKind(request),
		ownerKind: 'org',
		packageStampKind: input.packageStamp?.kind ?? 'none',
		packageId: input.packageStamp?.packageId ?? null,
		...(outcome.result === 'success'
			? {}
			: { errorClass: storedErrorClass(outcome.errorClass) }),
	}
	try {
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
					details,
				})
			})().catch((error: unknown) => {
				reportOrgAuditWriteFailure(
					'Failed to record MCP tool call audit event:',
					event,
					error,
				)
			}),
		)
	} catch (error) {
		reportOrgAuditWriteFailure(
			'Failed to record MCP tool call audit event:',
			event,
			error,
		)
	}
}
