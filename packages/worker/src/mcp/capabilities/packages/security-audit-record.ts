import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import {
	authorize,
	authorizePackageWrite,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { buildPackageCapabilityApprovalUrl } from '#worker/package-capabilities/capability-approval-url.ts'
import { loadCapabilityApprovalSummary } from '#worker/package-capabilities/capability-approval-service.ts'
import {
	attemptSelfPublish,
	type SelfPublishAttempt,
} from '#worker/package-capabilities/self-publish.ts'
import {
	selfPublishBlockerReasonSchema,
	selfPublishBlockerSchema,
} from '#worker/package-capabilities/self-publish-blocker-schema.ts'
import { getPendingWentPublicApproval } from '#worker/package-capabilities/went-public-approval.ts'
import {
	insertPackageSecurityAudit,
	packageSecurityAuditVerdicts,
} from '#worker/package-capabilities/security-audits-repo.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { redactErrorAgentPromptText } from '#universal/error-agent-prompt.ts'
import {
	packageSecurityAuditAnchor,
	packageSecurityAuditAuditorMaxLength,
	packageSecurityAuditSummaryMaxLength,
} from '#universal/package-security-audit-prompt.ts'

export const packageSecurityAuditRecordCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageSecurityAuditRecord',
		orgPermission: 'package:write',
		description:
			'Record an informational security audit for the exact published version of a saved package: its published commit plus capability-set fingerprint (both shown in the security audit prompt on the package capability approval page, and in the security_audit next step packageUpdate returns when a package moves toward internet-visible). Review that version first: declared vs used credentials, leaked credentials, unintended public exposure, risky network hosts, and package storage use. Then record verdict pass or concerns with a plain-language summary. The audit is tied to that commit and fingerprint; a new publish or changed capability set reads as not audited again. Recording an audit approves nothing by itself. One exception: when a request to make the package internet-visible is already pending (packageUpdate internet_visible: true), recording verdict pass re-evaluates self-publish, which makes the package internet-visible without the owner click (self_published: true) when the resolved capability set is empty and nothing in its dependency tree declares a credential or another capability. Otherwise hand the owner approval_url next. Requires package:read (to review the source) as well as package:write. Token-shaped strings in the summary are redacted.',
		keywords: [
			'package',
			'security',
			'audit',
			'review',
			'capabilities',
			'credentials',
			'secrets',
			'approval',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			package_id: z
				.string()
				.min(1)
				.describe('Saved package id that was audited.'),
			published_commit: z
				.string()
				.trim()
				.min(1)
				.describe(
					'Published commit SHA that was reviewed. Must match the package current published commit.',
				),
			fingerprint: z
				.string()
				.trim()
				.min(1)
				.describe(
					'Capability-set fingerprint that was reviewed. Must match the package current capability fingerprint.',
				),
			verdict: z
				.enum(packageSecurityAuditVerdicts)
				.describe(
					'`pass` when nothing concerning was found; `concerns` when the owner should look closer before approving.',
				),
			summary: z
				.string()
				.trim()
				.min(1)
				.max(packageSecurityAuditSummaryMaxLength)
				.describe(
					'Plain-language summary for the package owner: what was checked, what was found, and anything they should look at before approving. No secret values.',
				),
			auditor: z
				.string()
				.trim()
				.max(packageSecurityAuditAuditorMaxLength)
				.optional()
				.describe(
					'Optional name of the agent or person who performed the review, shown as "Audited by …". Defaults to the signed-in user.',
				),
		}),
		outputSchema: z.object({
			ok: z.literal(true),
			audit_id: z.string(),
			package_id: z.string(),
			published_commit: z.string(),
			fingerprint: z.string(),
			verdict: z.enum(packageSecurityAuditVerdicts),
			recorded_at: z.string(),
			audit_url: z.string(),
			approval_url: z
				.string()
				.describe('The package approval page to hand the owner next.'),
			next_step: z.string(),
			self_published: z
				.literal(true)
				.optional()
				.describe(
					'Present when this pass made the package internet-visible through self-publish for a pending internet-visible request.',
				),
			self_publish_blocker: selfPublishBlockerSchema
				.optional()
				.describe(
					'Present when an internet-visible request is pending and self-publish still does not apply; the owner approves at approval_url. Same values as packageUpdate self_publish_blocker.',
				),
			self_publish_blocker_reasons: z
				.array(selfPublishBlockerReasonSchema)
				.optional()
				.describe(
					'Structured reasons for self_publish_blocker (same shape as packageUpdate).',
				),
			self_publish_blocker_message: z
				.string()
				.optional()
				.describe(
					'Readable explanation of self_publish_blocker, including approval_url.',
				),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const savedPackage = await getSavedPackageById(ctx.env.APP_DB, {
				userId: owner.ownerUserId,
				packageId: args.package_id,
			})
			if (!savedPackage) {
				throw new McpCallerError('Saved package not found for this user.')
			}
			const authorizeCtx = { env: ctx.env, request: ctx.callerContext.request }
			const resource = {
				id: savedPackage.id,
				userId: savedPackage.userId,
				label: savedPackage.name,
			}
			await authorizePackageWrite(authorizeCtx, resource)
			// An auditor has to be able to read the source it vouches for.
			await authorize(authorizeCtx, 'package:read', packageResource(resource))
			const summary = await loadCapabilityApprovalSummary({
				env: ctx.env,
				ownerUserId: owner.ownerUserId,
				savedPackage,
				requestUrl: ctx.callerContext.baseUrl,
			})
			if (!summary.publishedCommit) {
				throw new McpCallerError(
					`"${savedPackage.name}" has no published version to audit. Publish it first, then audit the published commit.`,
				)
			}
			if (
				args.published_commit !== summary.publishedCommit ||
				args.fingerprint !== summary.capabilitySet.fingerprint
			) {
				throw new McpCallerError(
					`"${savedPackage.name}" changed since this audit started. The current published commit is ${summary.publishedCommit} and the capability fingerprint is ${summary.capabilitySet.fingerprint}. Re-audit the current version and record it with those values.`,
				)
			}

			const auditor = args.auditor?.trim()
			const auditorLabel = auditor ? redactErrorAgentPromptText(auditor) : null
			const record = await insertPackageSecurityAudit(ctx.env.APP_DB, {
				id: crypto.randomUUID(),
				packageId: savedPackage.id,
				ownerUserId: owner.ownerUserId,
				publishedCommit: summary.publishedCommit,
				fingerprint: summary.capabilitySet.fingerprint,
				verdict: args.verdict,
				summary: redactErrorAgentPromptText(args.summary),
				auditorLabel,
				recordedByUserId: owner.actorUserId,
				recordedAt: new Date().toISOString(),
			})
			await logAuditEvent({
				db: auditDatabaseFromEnv(ctx.env),
				category: 'account',
				action: 'package_security_audit_record',
				result: 'success',
				email: user.email,
				clientId: ctx.callerContext.oauthClientId ?? undefined,
				path: '/mcp',
				reason: [
					`package_id=${savedPackage.id}`,
					`published_commit=${record.publishedCommit}`,
					`fingerprint=${record.fingerprint}`,
					`verdict=${record.verdict}`,
					`audit_id=${record.id}`,
				].join(';'),
			})

			const approvalUrl = buildPackageCapabilityApprovalUrl({
				baseUrl: ctx.callerContext.baseUrl,
				username: owner.ownerScope,
				kodyId: savedPackage.kodyId,
			})
			const selfPublish = await reevaluatePendingSelfPublish({
				env: ctx.env,
				request: requireMcpRequest(ctx.callerContext),
				requestUrl: ctx.callerContext.baseUrl,
				ownerUserId: owner.ownerUserId,
				actorUserId: owner.actorUserId,
				savedPackage,
				summary,
				approvalUrl,
				verdict: record.verdict,
			})
			const blockedMessage =
				selfPublish?.status === 'blocked' ? selfPublish.detail.message : null
			return {
				ok: true as const,
				audit_id: record.id,
				package_id: record.packageId,
				published_commit: record.publishedCommit,
				fingerprint: record.fingerprint,
				verdict: record.verdict,
				recorded_at: record.recordedAt,
				audit_url: `${approvalUrl}#${packageSecurityAuditAnchor}`,
				approval_url: approvalUrl,
				next_step:
					selfPublish?.status === 'self_published'
						? `Audit recorded for published commit ${record.publishedCommit}, and the pending internet-visible request was self-published: the package is internet-visible now. The owner can review it at ${approvalUrl}.`
						: blockedMessage
							? `Audit recorded for published commit ${record.publishedCommit}. ${blockedMessage}`
							: `Audit recorded for published commit ${record.publishedCommit}. Send the owner ${approvalUrl} to read it and decide; recording an audit approves nothing.`,
				...(selfPublish?.status === 'self_published'
					? { self_published: true as const }
					: {}),
				...(selfPublish?.status === 'blocked'
					? {
							self_publish_blocker: selfPublish.blocker,
							self_publish_blocker_reasons: selfPublish.reasons,
							self_publish_blocker_message: selfPublish.detail.message,
						}
					: {}),
			}
		},
	},
)

/**
 * A pass recorded while an internet-visible request is pending gets the same
 * self-publish evaluation as toggling it again. A failed attempt leaves the
 * request pending for the owner; the audit stays recorded either way.
 */
async function reevaluatePendingSelfPublish(
	input: Parameters<typeof attemptSelfPublish>[0] & { verdict: string },
): Promise<SelfPublishAttempt | null> {
	if (input.verdict !== 'pass' || input.savedPackage.isInternetVisible) {
		return null
	}
	const pending = await getPendingWentPublicApproval({
		env: input.env,
		ownerUserId: input.ownerUserId,
		packageId: input.savedPackage.id,
	})
	if (!pending) return null
	// A request for an older publish can no longer be approved by anyone, so
	// self-publish enqueues one for the audited commit instead, as a re-toggle
	// would.
	const pendingRequestId =
		pending.baseCommit === input.summary.publishedCommit
			? pending.id
			: undefined
	try {
		return await attemptSelfPublish({ ...input, pendingRequestId })
	} catch (error) {
		// The audit is already recorded; failing here would invite a duplicate on retry.
		console.error('Self-publish re-evaluation after a security audit failed', {
			packageId: input.savedPackage.id,
			error,
		})
		return null
	}
}
