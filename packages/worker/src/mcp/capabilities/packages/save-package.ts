import { z } from 'zod'
import { buildPackageCapabilityApprovalUrl } from '#worker/package-capabilities/capability-approval-url.ts'
import {
	bundlePausedPublishes,
	pausedPublishBundleMessage,
} from '#worker/approval-bundles/paused-publishes.ts'
import { optionalApprovalViewerForCaller } from './approval-bundle-shared.ts'
import {
	createCredentialNeedsApprovalMessage,
	PackageCredentialNeedsApprovalError,
} from '#worker/credentials/credential-needs-approval.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	authorizePackageWrite,
	denyProfileBoundPackageCreate,
} from '#worker/authorization/authorize.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import {
	buildPackagePublishApprovalUrl,
	createPackagePublishLockedMessage,
	isPackagePublishLockedError,
} from '#worker/package-registry/package-publish-lock.ts'
import {
	isRepoChecksFailedError,
	repoChecksFailedCallerMessage,
} from '#worker/repo/repo-checks-failed-error.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'
import {
	deleteEntitySource,
	getEntitySourceByEntity,
} from '#worker/repo/entity-sources.ts'
import {
	buildRepoLargeFileMessage,
	findOversizedRepoSourceFile,
} from '#worker/repo/large-file-policy.ts'
import {
	assertPackageSourceOverwriteAllowed,
	assertPackagePrivateVisibilityChangeAllowed,
	defaultPackagePrivateGuidance,
	destructiveOverwriteConfirmationDescription,
	isDestructiveOverwriteConfirmationMessage,
	isPrivateVisibilityChangeConfirmationMessage,
	loadPriorPackageManifestContent,
	privateVisibilityChangeConfirmationDescription,
	productionPackageSourceSafetyPolicy,
} from '#worker/repo/source-safety-policy.ts'
import { injectDefaultPrivateField } from '#worker/package-registry/package-private.ts'
import {
	getSavedPackageById,
	resolveSavedPackageRef,
	getSavedPackageByName,
	insertSavedPackage,
} from '#worker/package-registry/repo.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { assertKodyDescriptionLength } from '#worker/package-registry/types.ts'
import {
	packageOwnerEntitlementEmail,
	resolvePackageOwnerContext,
} from '#worker/package-registry/package-owner.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import { scheduleKitSubscriberSync } from '#worker/kit/subscriber-sync.ts'
import { reportCapabilityProgress } from '#mcp/progress.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import { secretPageOrgSlugFromCaller } from '#mcp/secrets/package-approval-url.ts'
import {
	buildPendingPackageSecretApprovalsSummary,
	formatPendingPackageSecretApprovalsGuidance,
} from '#mcp/secrets/pending-package-secret-approvals.ts'
import {
	packageFileSchema,
	packageSummarySchema,
	pendingPackageSecretApprovalsSchema,
} from './shared.ts'
import { credentialPatternNoticeForFiles } from '#worker/repo/credential-pattern-check.ts'
import { buildCredentialAllowedPackagesPublishWarningNotice } from '#worker/credentials/credential-allowed-packages-publish-warning.ts'

function parseSavedPackageManifest(input: {
	content: string
	expectedPackageScope: string
}) {
	try {
		const manifest = parseAuthoredPackageJson({
			content: input.content,
			manifestPath: 'package.json',
			expectedPackageScope: input.expectedPackageScope,
		})
		assertKodyDescriptionLength(manifest.kody.description)
		return manifest
	} catch (error) {
		// Caller-authored package.json mistakes (wrong kody.dependencies shape,
		// scope mismatches, etc.) — keep them off Sentry via McpCallerError.
		throw new McpCallerError(getErrorMessage(error), { cause: error })
	}
}

const inputSchema = z
	.object({
		package_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Optional saved package id to update in place. Omit to create a new saved package.',
			),
		files: z
			.array(packageFileSchema)
			.min(1)
			.describe(
				'Full package file set to write. Must include package.json at the repo root.',
			),
		confirm_destructive_overwrite: z
			.boolean()
			.optional()
			.default(false)
			.describe(destructiveOverwriteConfirmationDescription),
		confirm_private_visibility_change: z
			.boolean()
			.optional()
			.default(false)
			.describe(privateVisibilityChangeConfirmationDescription),
	})
	.superRefine((value, ctx) => {
		const hasPackageJson = value.files.some(
			(file) => file.path.trim().replace(/^\.?\//, '') === 'package.json',
		)
		if (!hasPackageJson) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['files'],
				message: 'Saved packages require a root package.json file.',
			})
		}
	})

function normalizeFiles(files: Array<z.infer<typeof packageFileSchema>>) {
	const next: Record<string, string> = {}
	for (const file of files) {
		const normalizedPath = file.path.trim().replace(/^\.?\//, '')
		next[normalizedPath] = file.content.trimEnd() + '\n'
	}
	return next
}

export function buildPackageSaveNextSteps(input: {
	packageId: string
	pendingSecretApprovalsGuidance?: string | null
	credentialPatternsNotice?: string | null
	allowedPackagesPublishNotice?: string | null
}) {
	const steps = [
		'Coding agents with local filesystem/git access should use the git lane for further edits instead of re-sending full file sets:',
		`call packageGetGitRemote({ package_id: ${JSON.stringify(input.packageId)} }), run the returned setup_commands to clone into a temporary directory, edit and push normally, then publish with packagePublishExternalPush.`,
		'Binary assets and multi-file refactors are only supported through that git lane.',
		'Tool-only agents without local git can continue with packageSave or repo sessions.',
	]
	const guidance = input.pendingSecretApprovalsGuidance?.trim()
	if (guidance) {
		steps.push(guidance)
	}
	const notices = [
		input.credentialPatternsNotice,
		input.allowedPackagesPublishNotice,
	].filter((notice): notice is string => Boolean(notice?.trim()))
	const next = steps.join(' ')
	return notices.length > 0 ? `${next}\n\n${notices.join('\n\n')}` : next
}

/**
 * Per-user `saved_packages` uniqueness is on (user_id, name) and
 * (user_id, kody_id). packageSave resolves "existing" by package_id when
 * provided, otherwise by kody_id. A wrong/new package_id must not skip the
 * kody_id check and fall into INSERT — that surfaces as a raw D1 UNIQUE on
 * name (KODY-CLOUDFLARE-5J).
 */
export function buildSavedPackageNameCollisionMessage(input: {
	name: string
	existingKodyId: string
	existingPackageId: string
}) {
	return `A saved package named "${input.name}" already exists (name leaf "${input.existingKodyId}", package_id "${input.existingPackageId}"). Change package.json#name, or call packageSave with package_id "${input.existingPackageId}" to update that package (set confirm_destructive_overwrite: true only after the user explicitly approves overwriting).`
}

export function buildSavedPackageIdMismatchMessage(input: {
	requestedPackageId: string
	existingKodyId: string
	existingPackageId: string
}) {
	return `package_id "${input.requestedPackageId}" was not found. A saved package with name leaf "${input.existingKodyId}" already exists as package_id "${input.existingPackageId}". Omit package_id or pass package_id "${input.existingPackageId}" to update it (set confirm_destructive_overwrite: true only after the user explicitly approves overwriting).`
}

function isSavedPackageUniqueConstraintMessage(message: string) {
	return (
		/UNIQUE constraint failed/i.test(message) &&
		/saved_packages\.(name|kody_id|user_id)/i.test(message)
	)
}

function buildSavedPackageUniqueConstraintCallerMessage(input: {
	name: string
	kodyId: string
	message: string
}) {
	if (/saved_packages\.kody_id/i.test(input.message)) {
		return `A saved package with name leaf "${input.kodyId}" already exists. Call packageSave with that package's package_id to update it, or change package.json#name.`
	}
	return `A saved package named "${input.name}" already exists. Change package.json#name, or call packageSave with that package's package_id to update it.`
}

export const savePackageCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageSave',
		orgPermission: 'package:write',
		description: `Create or replace a saved package by writing a complete UTF-8 text file set (no binary assets). Coding agents with local filesystem/git access should prefer packageGetGitRemote (pass create: true for new packages) to clone, edit, push, and publish with packagePublishExternalPush; tool-only agents use packageSave or repo sessions. The package repo is rooted at package.json and package.json#kody is the Kody-specific metadata block. Publish requires non-empty root README.md (human-focused: what it does, prerequisites, setup, done-when, plus a concise Intent section) and AGENTS.md (agent-focused: imports, smoke tests, edge cases). Ask the user if intent is unclear. ${defaultPackagePrivateGuidance} ${productionPackageSourceSafetyPolicy}`,
		keywords: [
			'package',
			'save',
			'create',
			'update',
			'repo',
			'package.json',
			'readme',
			'intent',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema,
		outputSchema: packageSummarySchema.extend({
			next_steps: z
				.string()
				.describe(
					'Follow-up guidance for continuing package work, including the git clone-edit-push lane for coding agents and any pending package secret approvals.',
				),
			pending_secret_package_approvals: pendingPackageSecretApprovalsSchema,
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			let files = normalizeFiles(args.files)
			let packageJsonContent = files['package.json']
			if (!packageJsonContent) {
				throw new McpCallerError(
					'Saved packages require a root package.json file.',
				)
			}
			const expectedPackageScope = owner.ownerScope
			const lookupManifest = parseSavedPackageManifest({
				content: packageJsonContent,
				expectedPackageScope,
			})
			let existing =
				args.package_id !== undefined
					? await getSavedPackageById(ctx.env.APP_DB, {
							userId: owner.ownerUserId,
							packageId: args.package_id,
						})
					: await resolveSavedPackageRef(ctx.env.APP_DB, {
							userId: owner.ownerUserId,
							ref: lookupManifest.kody.id,
							match: 'slug',
						})
			if (!existing && args.package_id !== undefined) {
				const byKodyId = await resolveSavedPackageRef(ctx.env.APP_DB, {
					userId: owner.ownerUserId,
					ref: lookupManifest.kody.id,
					match: 'slug',
				})
				if (byKodyId) {
					throw new McpCallerError(
						buildSavedPackageIdMismatchMessage({
							requestedPackageId: args.package_id,
							existingKodyId: byKodyId.kodyId,
							existingPackageId: byKodyId.id,
						}),
					)
				}
			}
			const authorizeCtx = {
				env: ctx.env,
				request: ctx.callerContext.request,
			}
			if (existing) {
				await authorizePackageWrite(authorizeCtx, {
					id: existing.id,
					userId: existing.userId,
					label: existing.name,
				})
			} else {
				await denyProfileBoundPackageCreate(authorizeCtx)
			}
			if (!existing) {
				await assertWithinEntitlement({
					db: ctx.env.APP_DB,
					userId: owner.ownerUserId,
					email: packageOwnerEntitlementEmail(owner),
					resource: 'saved_packages',
				})
				packageJsonContent = injectDefaultPrivateField(packageJsonContent)
				files = { ...files, 'package.json': packageJsonContent }
			}
			// Gate on the final file set (after injectDefaultPrivateField) so the
			// exact bytes handed to syncArtifactSourceSnapshot are what was checked.
			const oversizedFile = findOversizedRepoSourceFile(Object.entries(files))
			if (oversizedFile) {
				throw new McpCallerError(buildRepoLargeFileMessage(oversizedFile))
			}
			const manifest = parseSavedPackageManifest({
				content: packageJsonContent,
				expectedPackageScope,
			})
			const packageId = existing?.id ?? args.package_id ?? crypto.randomUUID()
			const nameOwner = await getSavedPackageByName(ctx.env.APP_DB, {
				userId: owner.ownerUserId,
				name: manifest.name,
			})
			if (nameOwner && nameOwner.id !== packageId) {
				throw new McpCallerError(
					buildSavedPackageNameCollisionMessage({
						name: manifest.name,
						existingKodyId: nameOwner.kodyId,
						existingPackageId: nameOwner.id,
					}),
				)
			}
			const canonicalExistingSource =
				existing == null
					? null
					: await getEntitySourceByEntity(ctx.env.APP_DB, {
							userId: owner.ownerUserId,
							entityKind: 'package',
							entityId: packageId,
						})
			const ensuredSource = await ensureEntitySource({
				db: ctx.env.APP_DB,
				env: ctx.env,
				userId: owner.ownerUserId,
				entityKind: 'package',
				entityId: packageId,
				sourceRoot: '/',
				manifestPath: 'package.json',
				requirePersistence: true,
			})
			const priorManifestContent =
				existing == null
					? null
					: await loadPriorPackageManifestContent({
							env: ctx.env,
							userId: owner.ownerUserId,
							source:
								canonicalExistingSource?.id === ensuredSource.id
									? canonicalExistingSource
									: ensuredSource,
						})
			try {
				assertPackagePrivateVisibilityChangeAllowed({
					beforeContent: priorManifestContent,
					afterContent: packageJsonContent,
					isNewPackage: existing == null,
					operation: 'packageSave',
					confirmed: args.confirm_private_visibility_change,
				})
			} catch (error) {
				const message = getErrorMessage(error)
				if (isPrivateVisibilityChangeConfirmationMessage(message)) {
					throw new McpCallerError(message, { cause: error })
				}
				throw error
			}
			if (existing) {
				try {
					await assertPackageSourceOverwriteAllowed({
						env: ctx.env,
						userId: owner.ownerUserId,
						source:
							canonicalExistingSource?.id === ensuredSource.id
								? canonicalExistingSource
								: ensuredSource,
						operation: 'packageSave',
						confirmed: args.confirm_destructive_overwrite,
					})
				} catch (error) {
					const message = getErrorMessage(error)
					// Shared policy helpers throw plain Errors; reclassify the
					// confirmation gate so agents see McpCallerError and Sentry
					// does not open platform-bug issues (KODY issue 7661329778).
					if (isDestructiveOverwriteConfirmationMessage(message)) {
						throw new McpCallerError(message, { cause: error })
					}
					throw error
				}
			}
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: 1,
				total: 4,
				message: 'Syncing your package source — filing bits into the vault…',
			})
			try {
				await syncArtifactSourceSnapshot({
					env: ctx.env,
					userId: owner.ownerUserId,
					baseUrl: ctx.callerContext.baseUrl,
					sourceId: ensuredSource.id,
					bootstrapAccess: ensuredSource.bootstrapAccess ?? null,
					files,
					destructiveOverwriteConfirmed: args.confirm_destructive_overwrite,
					privateVisibilityChangeConfirmed:
						args.confirm_private_visibility_change,
					requestedByUserId: ctx.callerContext.user?.userId ?? null,
				})
			} catch (error) {
				if (error instanceof PackageCredentialNeedsApprovalError) {
					const message = createCredentialNeedsApprovalMessage({
						packageName: error.approval.packageName,
						changes: error.approval.changes,
						approvalUrl: buildPackageCapabilityApprovalUrl({
							baseUrl: ctx.callerContext.baseUrl,
							username: owner.ownerScope,
							kodyId: error.approval.kodyId,
						}),
					})
					const bundle = await bundlePausedPublishes({
						viewer: optionalApprovalViewerForCaller(ctx),
						ownerUserId: owner.ownerUserId,
					})
					throw new McpCallerError(
						bundle
							? `${message} ${pausedPublishBundleMessage(bundle)}`
							: message,
						{ cause: error },
					)
				}
				if (isPackagePublishLockedError(error)) {
					throw new McpCallerError(
						createPackagePublishLockedMessage({
							packageName: error.packageName,
							approvalUrl: buildPackagePublishApprovalUrl({
								baseUrl: ctx.callerContext.baseUrl,
								username: owner.ownerScope,
								kodyId: existing?.kodyId ?? manifest.kody.id,
								commit: error.pendingCommit,
							}),
						}),
						{ cause: error },
					)
				}
				// Failed publish/repo checks (typecheck, docs, …) are caller
				// package bugs. Subclass identity may not survive RepoSession
				// DO RPC on the bootstrap path — match name / JSRPC prefix.
				// KODY-96.
				if (isRepoChecksFailedError(error)) {
					throw new McpCallerError(repoChecksFailedCallerMessage(error), {
						cause: error,
					})
				}
				throw error
			}
			if (!existing) {
				const now = new Date().toISOString()
				try {
					// Stamp happens here; projection refresh below sees an existing
					// row and will not Kit-sync. Sync now when the actor was newly
					// activated.
					const stamped = await insertSavedPackage(
						ctx.env.APP_DB,
						{
							id: packageId,
							user_id: owner.ownerUserId,
							name: manifest.name,
							description: manifest.kody.description,
							tags_json: JSON.stringify(manifest.kody.tags ?? []),
							search_text: manifest.kody.searchText ?? null,
							source_id: ensuredSource.id,
							has_app: manifest.kody.app ? 1 : 0,
							has_skills: 0,
							hidden: 0,
							is_private: 1,
							created_at: now,
							updated_at: now,
						},
						ctx.env,
						{ actorUserId: owner.actorUserId },
					)
					if (stamped) {
						scheduleKitSubscriberSync({
							env: ctx.env,
							stableUserId: owner.actorUserId,
						})
					}
				} catch (error) {
					const message = getErrorMessage(error)
					// Pre-check covers the common path; this catches races where
					// another create won the (user_id, name) or (user_id, kody_id)
					// unique index between lookup and insert. Drop only the source
					// this invocation just created so a retry does not orphan it.
					if (isSavedPackageUniqueConstraintMessage(message)) {
						await deleteEntitySource(ctx.env, {
							id: ensuredSource.id,
							userId: owner.ownerUserId,
						})
						throw new McpCallerError(
							buildSavedPackageUniqueConstraintCallerMessage({
								name: manifest.name,
								kodyId: manifest.kody.id,
								message,
							}),
							{ cause: error },
						)
					}
					throw error
				}
			}
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: 2,
				total: 4,
				message:
					'Publishing the saved-package projection — jobs, artifacts, and a tidy D1 row…',
			})
			const refreshed = await refreshSavedPackageProjection({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: owner.ownerUserId,
				actorUserId: owner.actorUserId,
				userEmail: packageOwnerEntitlementEmail(owner),
				packageId,
				sourceId: ensuredSource.id,
				waitUntil: ctx.waitUntil,
			})
			const saved = refreshed.record
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: 3,
				total: 4,
				message: 'Checking pending secret approvals — no spoilers, just gates…',
			})
			const publishedFiles = refreshed.files ?? files
			const pendingSecretApprovals =
				await buildPendingPackageSecretApprovalsSummary({
					env: ctx.env,
					baseUrl: ctx.callerContext.baseUrl,
					userId: owner.ownerUserId,
					orgSlug: secretPageOrgSlugFromCaller(ctx.callerContext),
					packageId: saved.id,
					kodyId: saved.kodyId,
					secretMounts: manifest.kody.secretMounts,
					files,
					storageContext: {
						sessionId: null,
						appId: null,
						packageId: saved.id,
						storageId: null,
					},
				})
			let allowedPackagesPublishNotice: string | null = null
			try {
				allowedPackagesPublishNotice =
					await buildCredentialAllowedPackagesPublishWarningNotice({
						env: ctx.env,
						baseUrl: ctx.callerContext.baseUrl,
						userId: owner.ownerUserId,
						orgSlug: secretPageOrgSlugFromCaller(ctx.callerContext),
						packageId: saved.id,
						packageDisplayName: saved.name,
						kodyId: saved.kodyId,
						// An existing package keeps files this save omits, so scan the
						// published set the projection loaded.
						files: publishedFiles,
						slots: manifest.kody.credentials,
					})
			} catch {
				// Warning is best-effort: never fail save after persistence.
				allowedPackagesPublishNotice = null
			}
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: 4,
				total: 4,
				message: 'Package save complete — ready when you are.',
			})
			return {
				package_id: saved.id,
				kody_id: saved.kodyId,
				slug: saved.kodyId,
				name: saved.name,
				description: saved.description,
				tags: saved.tags,
				has_app: saved.hasApp,
				hidden: saved.hidden,
				visibility: saved.isPrivate
					? ('private' as const)
					: ('public' as const),
				internet_visible: saved.isInternetVisible,
				locked_at: saved.lockedAt ?? null,
				source_id: saved.sourceId,
				created_at: saved.createdAt,
				updated_at: saved.updatedAt,
				pending_secret_package_approvals: pendingSecretApprovals,
				next_steps: buildPackageSaveNextSteps({
					packageId: saved.id,
					pendingSecretApprovalsGuidance: pendingSecretApprovals
						? formatPendingPackageSecretApprovalsGuidance(
								pendingSecretApprovals,
							)
						: null,
					credentialPatternsNotice:
						credentialPatternNoticeForFiles(publishedFiles),
					allowedPackagesPublishNotice,
				}),
			}
		},
	},
)
