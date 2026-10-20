import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { authorizePackageWrite } from '#worker/authorization/authorize.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import {
	buildPackageUnlockUrl,
	createPackageUnlockRequiredMessage,
	isSavedPackageLocked,
} from '#worker/package-registry/package-publish-lock.ts'
import {
	getSavedPackageById,
	setSavedPackageLockedAt,
	updateSavedPackage,
} from '#worker/package-registry/repo.ts'
import {
	publishCommunityListing,
	unpublishCommunityListing,
} from '#worker/community/service.ts'
import { getCommunityListingByOwnerAndPackage } from '#worker/community/repo.ts'
import { buildPackageCapabilityApprovalUrl } from '#worker/package-capabilities/capability-approval-url.ts'
import {
	clearInternetVisible,
	loadCapabilityApprovalSummary,
} from '#worker/package-capabilities/capability-approval-service.ts'
import {
	applyMatchingPinInternetVisible,
	attemptSelfPublish,
	type SelfPublishAttempt,
} from '#worker/package-capabilities/self-publish.ts'
import {
	selfPublishBlockerReasonSchema,
	selfPublishBlockerSchema,
} from '#worker/package-capabilities/self-publish-blocker-schema.ts'
import {
	enqueueWentPublicApproval,
	getPendingWentPublicApproval,
} from '#worker/package-capabilities/went-public-approval.ts'
import {
	loadPackageSecurityAuditNextStep,
	type PackageSecurityAuditNextStep,
} from '#worker/package-capabilities/security-audit-next-step.ts'
import { packageSecurityAuditRecordOperation } from '#universal/package-security-audit-prompt.ts'
import { packageSummarySchema, toPackageSummary } from './shared.ts'

const securityAuditNextStepSchema = z.object({
	next_step: z.string(),
	operation: z.literal(packageSecurityAuditRecordOperation),
	http_route: z.string(),
	args: z
		.object({
			package_id: z.string(),
			published_commit: z.string(),
			fingerprint: z.string(),
		})
		.describe(
			`Exact values for ${packageSecurityAuditRecordOperation}. Add verdict ("pass" or "concerns"), summary, and optionally auditor.`,
		),
	audit_prompt: z
		.string()
		.describe('What to review and how to record it, as the owner would ask.'),
})

function toSecurityAuditNextStepOutput(step: PackageSecurityAuditNextStep) {
	return {
		next_step: step.nextStep,
		operation: step.operation,
		http_route: step.httpRoute,
		args: step.args,
		audit_prompt: step.auditPrompt,
	}
}

const packageUpdateChangesSchema = z
	.strictObject({
		hidden: z
			.boolean()
			.optional()
			.describe(
				'When true, hide the package from ranked search discovery by default.',
			),
		locked: z
			.boolean()
			.optional()
			.describe(
				'When true, lock publishes so later agent publishes need a website click. Agents can lock but cannot unlock; send the owner to the package page (/@{username}/{kodyId}) to unlock.',
			),
		visibility: z
			.enum(['public', 'private'])
			.optional()
			.describe(
				'Repo visibility / forkable. Public means default-branch HEAD is world-readable and forkable and the package appears on /community. Before setting public, review the package for overly personal content (package_authoring visibility). If anything looks personal, stop, tell the user, suggest generalizing, and wait for explicit go-ahead. Private is owner-only. Changing to private unlists the catalog entry; existing forks keep their copies. Independent of internet_visible.',
			),
		internet_visible: z
			.boolean()
			.optional()
			.describe(
				`Internet-visible app serving. Independent of visibility/forkable. Setting true makes the package internet-visible right away when either (1) self-publish applies (the resolved capability set is empty, nothing in the dependency tree declares a credential or another capability, a security audit with verdict pass is recorded for the current published commit + fingerprint, and the caller may package:publish), or (2) the owner already approved the current capability set (matching pin) — then went_public is approved without another Approve click. An unpublished package is refused with an error: publish it first. Otherwise agents cannot approve the capability set: it returns an approval_url for the owner website and self_publish_blocker (or self_publish_error when applying a matching pin failed) says why. When the published version has no security audit, it also returns security_audit: run that audit and record it with ${packageSecurityAuditRecordOperation} using security_audit.args. Recording verdict pass re-evaluates the pending request and self-publishes when everything else allows it; otherwise hand the owner approval_url. Calling this again with internet_visible true also re-evaluates. Setting false turns off public app serving (requires confirm_name).`,
			),
	})
	.refine(
		(changes) =>
			changes.hidden !== undefined ||
			changes.locked !== undefined ||
			changes.visibility !== undefined ||
			changes.internet_visible !== undefined,
		{
			message: 'Provide at least one supported package change.',
		},
	)

export const packageUpdateCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageUpdate',
		orgPermission: 'package:write',
		description:
			'Update mutable settings for a saved package: hidden search-discovery, publish lock (`changes.locked: true`; agents cannot unlock), repo visibility / forkable (`changes.visibility`), and internet-visible app serving (`changes.internet_visible`). Making a package public lists it on /community with full source and fork. Before setting visibility public, review source, README, Intent, description, tags, examples, and hardcoded identifiers for overly personal material. If anything looks personal or household-specific, do not publish yet — tell the user what you found, suggest how to generalize, and wait for explicit go-ahead. No MIT, logo, or Intent platform gates. Making it private unlists it (public URLs 404; forks keep their copies) — pass confirm_name matching the package slug after the owner typed that name. Internet-visible is independent of forkable and requires owner capability approval on the website. Canonical package metadata such as name, description, and tags remains derived from package.json. Visibility is not package.json#private.',
		keywords: [
			'package',
			'update',
			'hidden',
			'visibility',
			'public',
			'private',
			'forkable',
			'internet-visible',
			'search',
			'lock',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.strictObject({
			package_id: z.string().min(1).describe('Saved package id.'),
			changes: packageUpdateChangesSchema,
			confirm_name: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Required when changes.visibility is private or changes.internet_visible is false. Must equal the package slug (URL name). Confirm with the user first.',
				),
		}),
		outputSchema: z.object({
			ok: z.literal(true),
			package: packageSummarySchema,
			approval_url: z
				.string()
				.optional()
				.describe(
					'Present when internet_visible was requested and is waiting on owner Approve (went_public). One Approve on that page records the capability set and turns internet-visible on.',
				),
			internet_visible_pending: z
				.boolean()
				.optional()
				.describe(
					'True when other package changes applied but internet-visible is waiting on owner Approve.',
				),
			security_audit: securityAuditNextStepSchema
				.optional()
				.describe(
					`Present when internet-visible is pending and the published version has no security audit. Do this before handing the owner approval_url: audit, then record with ${packageSecurityAuditRecordOperation}.`,
				),
			self_published: z
				.literal(true)
				.optional()
				.describe(
					'Present when internet_visible was turned on without owner Approve because the package declares no credential or capability. The package cannot use any credential while public this way.',
				),
			self_publish_blocker: selfPublishBlockerSchema
				.optional()
				.describe(
					`Why internet_visible waits on owner Approve instead of self-publishing: the capability set has credentials or storage to approve, a package in the tree is unpublished, a dependency republished since this package's publish (stale_dependencies: publish this package again), the tree declares credentials, the tree declares other capabilities, the current published commit + fingerprint has no security audit (not_audited) or one with verdict concerns (audit_concerns), or the caller may not publish this package. For not_audited: audit, record verdict pass with ${packageSecurityAuditRecordOperation}; that re-evaluates the pending request.`,
				),
			self_publish_blocker_reasons: z
				.array(selfPublishBlockerReasonSchema)
				.optional()
				.describe(
					'Structured reasons for self_publish_blocker: which capability (storage, mounts, jobs, webhooks, credentials, etc.), and for text-detected storage which file and line matched.',
				),
			self_publish_blocker_message: z
				.string()
				.optional()
				.describe(
					'Readable one-or-two sentence explanation of self_publish_blocker, including the approval URL when present.',
				),
			self_publish_error: z
				.string()
				.optional()
				.describe(
					'Present when self-publish applied but its approval failed; internet_visible waits on owner Approve at approval_url instead.',
				),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const existing = await getSavedPackageById(ctx.env.APP_DB, {
				userId: owner.ownerUserId,
				packageId: args.package_id,
			})
			if (!existing) {
				throw new McpCallerError('Saved package not found for this user.')
			}
			await authorizePackageWrite(
				{ env: ctx.env, request: ctx.callerContext.request },
				{
					id: existing.id,
					userId: existing.userId,
					label: existing.name,
				},
			)
			if (args.changes.locked === false) {
				throw new McpCallerError(
					createPackageUnlockRequiredMessage(
						buildPackageUnlockUrl({
							baseUrl: ctx.callerContext.baseUrl,
							username: owner.ownerScope,
							kodyId: existing.kodyId,
						}),
					),
				)
			}
			if (args.changes.hidden !== undefined) {
				const changed = await updateSavedPackage(ctx.env.APP_DB, {
					userId: owner.ownerUserId,
					packageId: args.package_id,
					hidden: args.changes.hidden,
				})
				if (!changed) {
					throw new McpCallerError('Saved package not found for this user.')
				}
			}
			if (
				args.changes.locked === true &&
				!isSavedPackageLocked(existing.lockedAt)
			) {
				const locked = await setSavedPackageLockedAt(ctx.env.APP_DB, {
					userId: owner.ownerUserId,
					packageId: args.package_id,
					lockedAt: new Date().toISOString(),
				})
				if (!locked) {
					throw new McpCallerError('Saved package not found for this user.')
				}
			}
			if (args.changes.visibility === 'public' && existing.isPrivate) {
				await publishCommunityListing({
					env: ctx.env,
					baseUrl: ctx.callerContext.baseUrl,
					userId: owner.ownerUserId,
					actorUserId: owner.actorUserId,
					packageId: args.package_id,
				})
			}
			if (args.changes.visibility === 'private' && !existing.isPrivate) {
				const expectedName = existing.kodyId
				if (args.confirm_name?.trim() !== expectedName) {
					throw new McpCallerError(
						`Making this package private unlists it from /community and 404s public URLs. Existing forks keep their copies. Confirm with the user, then pass confirm_name: "${expectedName}" (the package slug).`,
					)
				}
				const listing = await getCommunityListingByOwnerAndPackage(
					ctx.env.APP_DB,
					{
						ownerUserId: owner.ownerUserId,
						packageId: args.package_id,
					},
				)
				if (listing && listing.status === 'active') {
					await unpublishCommunityListing({
						env: ctx.env,
						userId: owner.ownerUserId,
						actorUserId: owner.actorUserId,
						listingId: listing.id,
					})
				} else {
					const changed = await updateSavedPackage(ctx.env.APP_DB, {
						userId: owner.ownerUserId,
						packageId: args.package_id,
						isPrivate: true,
					})
					if (!changed) {
						throw new McpCallerError('Saved package not found for this user.')
					}
				}
			}

			let internetVisiblePending = false
			let selfPublished = false
			let selfPublishBlocker:
				| Extract<SelfPublishAttempt, { status: 'blocked' }>['blocker']
				| null = null
			let selfPublishBlockerReasons: Extract<
				SelfPublishAttempt,
				{ status: 'blocked' }
			>['reasons'] = []
			let selfPublishBlockerMessage: string | null = null
			let selfPublishError: string | null = null
			let approvalUrl: string | undefined
			let securityAudit: PackageSecurityAuditNextStep | null = null
			if (
				args.changes.internet_visible === true &&
				!existing.isInternetVisible
			) {
				approvalUrl = buildPackageCapabilityApprovalUrl({
					baseUrl: ctx.callerContext.baseUrl,
					username: owner.ownerScope,
					kodyId: existing.kodyId,
				})
				const summary = await loadCapabilityApprovalSummary({
					env: ctx.env,
					ownerUserId: owner.ownerUserId,
					savedPackage: existing,
					requestUrl: ctx.callerContext.baseUrl,
				})
				if (!summary.publishedCommit) {
					throw new McpCallerError(
						`Publish the package before making it internet-visible. Then send the owner to approve capabilities: ${approvalUrl}`,
					)
				}
				const attempt = await attemptSelfPublish({
					env: ctx.env,
					request: requireMcpRequest(ctx.callerContext),
					requestUrl: ctx.callerContext.baseUrl,
					ownerUserId: owner.ownerUserId,
					actorUserId: owner.actorUserId,
					savedPackage: existing,
					summary,
					approvalUrl,
				})
				if (attempt.status === 'failed') {
					// A failed attempt leaves the request it saw pending; with none
					// pending (resolved meanwhile), the summary is not worth re-asking on.
					const pending = await getPendingWentPublicApproval({
						env: ctx.env,
						ownerUserId: owner.ownerUserId,
						packageId: existing.id,
					})
					if (!pending) {
						throw new McpCallerError(
							`${attempt.error} Nothing is pending for the owner; call packageUpdate with internet_visible true again.`,
						)
					}
					selfPublishError = attempt.error
				}
				if (attempt.status === 'blocked') {
					selfPublishBlocker = attempt.blocker
					selfPublishBlockerReasons = attempt.reasons
					selfPublishBlockerMessage = attempt.detail.message
				}
				if (attempt.status === 'self_published') {
					selfPublished = true
				} else if (selfPublishError) {
					// Its pending request already waits on the owner's Approve click.
				} else if (summary.fingerprintMatchesApproval) {
					// The owner already approved this capability set — turn
					// internet-visible on now without another Approve click.
					const applied = await applyMatchingPinInternetVisible({
						env: ctx.env,
						requestUrl: ctx.callerContext.baseUrl,
						ownerUserId: owner.ownerUserId,
						actorUserId: owner.actorUserId,
						savedPackage: existing,
						fingerprint: summary.capabilitySet.fingerprint,
					})
					if (!applied.ok) {
						// A concurrent clear may have removed the pending row —
						// only hand the owner an approval_url when something
						// still waits; otherwise ask the agent to retry.
						const pending = await getPendingWentPublicApproval({
							env: ctx.env,
							ownerUserId: owner.ownerUserId,
							packageId: existing.id,
						})
						if (!pending) {
							throw new McpCallerError(
								`${applied.error} Nothing is pending for the owner; call packageUpdate with internet_visible true again.`,
							)
						}
						selfPublishError = applied.error
					}
				} else {
					// Agents cannot approve capabilities. Record the ask so the
					// owner's one Approve covers the capability set and going public.
					await enqueueWentPublicApproval({
						env: ctx.env,
						ownerUserId: owner.ownerUserId,
						savedPackage: existing,
						publishedCommit: summary.publishedCommit,
						fingerprint: summary.capabilitySet.fingerprint,
						requestedByUserId: owner.actorUserId,
					})
				}
				// Pending when the owner still must Approve (no matching pin yet,
				// or applying a matching pin's went_public failed with a row
				// still waiting). A matching pin that applied is already on.
				if (attempt.status === 'self_published') {
					internetVisiblePending = false
				} else if (
					summary.fingerprintMatchesApproval &&
					!selfPublishError &&
					attempt.status !== 'failed'
				) {
					internetVisiblePending = false
				} else {
					internetVisiblePending = true
				}
				if (internetVisiblePending) {
					securityAudit = await loadPackageSecurityAuditNextStep({
						db: ctx.env.APP_DB,
						ownerUserId: owner.ownerUserId,
						packageId: existing.id,
						packageName: existing.name,
						publishedCommit: summary.publishedCommit,
						fingerprint: summary.capabilitySet.fingerprint,
						approvalUrl,
					})
				}
			}
			if (args.changes.internet_visible === false) {
				const expectedName = existing.kodyId
				if (args.confirm_name?.trim() !== expectedName) {
					throw new McpCallerError(
						`Turning off internet-visible returns the app to owner-session serving. Confirm with the user, then pass confirm_name: "${expectedName}" (the package slug).`,
					)
				}
				// Also runs when already off so a pending went_public is superseded.
				const changed = await clearInternetVisible({
					env: ctx.env,
					ownerUserId: owner.ownerUserId,
					packageId: args.package_id,
					actorUserId: owner.actorUserId,
				})
				if (!changed) {
					throw new McpCallerError('Saved package not found for this user.')
				}
			}

			const savedPackage = await getSavedPackageById(ctx.env.APP_DB, {
				userId: owner.ownerUserId,
				packageId: args.package_id,
			})
			if (!savedPackage) {
				throw new McpCallerError('Saved package not found for this user.')
			}
			return {
				ok: true as const,
				package: toPackageSummary(savedPackage),
				...(internetVisiblePending && approvalUrl
					? {
							approval_url: approvalUrl,
							internet_visible_pending: true as const,
							...(selfPublishBlocker
								? {
										self_publish_blocker: selfPublishBlocker,
										self_publish_blocker_reasons: selfPublishBlockerReasons,
										self_publish_blocker_message:
											selfPublishBlockerMessage ?? undefined,
									}
								: {}),
							...(selfPublishError
								? { self_publish_error: selfPublishError }
								: {}),
						}
					: {}),
				...(securityAudit
					? { security_audit: toSecurityAuditNextStepOutput(securityAudit) }
					: {}),
				...(selfPublished ? { self_published: true as const } : {}),
			}
		},
	},
)
