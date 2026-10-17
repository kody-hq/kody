import {
	type OwnerId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import { resolveHostedPackageAppUrl } from '@kody-internal/shared/public-urls.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	defaultDurableEscalationBudgetMs,
	runWithDurableEscalation,
} from '#mcp/capabilities/durable-escalation.ts'
import {
	errorCauseChainIncludes,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import { isDurableObjectIsolateResetMessage } from '#worker/sentry-options.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { authorizePackageWrite } from '#worker/authorization/authorize.ts'
import { resolvePublicUsername } from '#worker/identity/user-lookup.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { requestLineage } from '#worker/request-context/request-context.ts'
import {
	annotateStaticDependentsWithSecretMounts,
	appendSecretMountCompatNotice,
} from '#worker/package-runtime/secret-mount-compat.ts'
import {
	getStaticPackageDependentsSummary,
	type StaticPackageDependentsSummary,
} from '#worker/package-runtime/static-package-dependents.ts'
import {
	packageOwnerEntitlementEmail,
	resolvePackageOwnerContext,
} from '#worker/package-registry/package-owner.ts'
import { type EnablementHintTrigger } from '#worker/enablements/enablement-agent-hints.ts'
import { listPublisherEnablementGaps } from '#worker/enablements/publisher-enablement-gaps.ts'
import {
	buildPackageTestHints,
	type PackageTestHints,
} from '#worker/package-registry/package-test-hints.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import { rebuildPublishedPackageArtifactsViaRepoSession } from '#mcp/capabilities/repo/package-artifact-rebuild.ts'
import {
	mergePublishPhaseTimings,
	timePublishExternalPushPhase,
	withPublishAttemptTotalMs,
	type PublishPhaseTimings,
} from '#worker/repo/publish-phase-timing.ts'
import { destructiveOverwriteConfirmationDescription } from '#worker/repo/source-safety-policy.ts'
import { secretPageOrgSlugFromCaller } from '#mcp/secrets/package-approval-url.ts'
import {
	buildPendingPackageSecretApprovalsSummary,
	type PendingPackageSecretApprovalsSummary,
} from '#mcp/secrets/pending-package-secret-approvals.ts'
import { loadPublishedEntitySource } from '#worker/repo/published-source.ts'
import {
	buildPackagePublishApprovalUrl,
	createPackagePublishLockedMessage,
} from '#worker/package-registry/package-publish-lock.ts'
import { buildPackageCapabilityApprovalUrl } from '#worker/package-capabilities/capability-approval-url.ts'
import { createCredentialNeedsApprovalMessage } from '#worker/credentials/credential-needs-approval.ts'
import { type ApprovalViewer } from '#worker/approval-bundles/item-views.ts'
import {
	bundlePausedPublishes,
	pausedPublishBundleMessage,
} from '#worker/approval-bundles/paused-publishes.ts'
import { optionalApprovalViewerForCaller } from './approval-bundle-shared.ts'
import {
	credentialNeedChangeSchema,
	pendingPackageSecretApprovalsSchema,
} from './shared.ts'
import { resolveOwnedPackageSource } from './resolve-package-source.ts'
import {
	reportCapabilityProgress,
	type McpReportProgress,
} from '#mcp/progress.ts'
import {
	readPromotedVersionFromManifest,
	resolveListingBehindPublishHint,
} from '#worker/community/resolve-listing-behind-publish-hint.ts'
import { buildUpdatePublicListingHref } from '#universal/update-public-listing.ts'

const inputSchema = z.object({
	package_id: z.string().min(1).optional(),
	kody_id: z.string().min(1).optional(),
	allow_force: z.boolean().optional().default(false),
	confirm_destructive_overwrite: z
		.boolean()
		.optional()
		.default(false)
		.describe(destructiveOverwriteConfirmationDescription),
})

const externalPublishRetryDelaysMs = [100, 500] as const

const durablePublishWorkflowCode = `import { kody } from 'kody:runtime'
export default async function main(params = {}) {
	return await kody.packagePublishExternalPush(params)
}`

function isTransientDurableObjectResetError(error: unknown) {
	// Exact platform reset strings (including deploy "code was updated").
	// Substring matching on "Durable Object was reset" misses that form —
	// Cloudflare says "Durable Object reset because…" with no "was".
	return errorCauseChainIncludes(error, isDurableObjectIsolateResetMessage)
}

function bundleCheckFailedFromRebuildError(error: unknown) {
	return {
		kind: 'bundle' as const,
		ok: false as const,
		message: getErrorMessage(error),
	}
}

function logExternalPublishRetry(input: {
	sourceId: string
	repoId: string
	packageId: string
	newCommit: string
	attempt: number
	nextDelayMs: number
	error: unknown
}) {
	// Log-only: DO isolate memory/CPU resets are retried; do not open Sentry
	// issues per attempt. Exhausted retries still throw and hit MCP observability.
	const errorMessage = getErrorMessage(input.error)
	console.warn(
		JSON.stringify({
			message: 'packagePublishExternalPush transient Durable Object reset',
			sourceId: input.sourceId,
			repoId: input.repoId,
			packageId: input.packageId,
			newCommit: input.newCommit,
			attempt: input.attempt,
			nextDelayMs: input.nextDelayMs,
			errorMessage,
		}),
	)
}

function assertNotAborted(signal: AbortSignal | undefined) {
	if (signal?.aborted) {
		throw new DOMException('The publish attempt was aborted.', 'AbortError')
	}
}

async function delay(ms: number, signal?: AbortSignal) {
	assertNotAborted(signal)
	if (!signal) {
		await new Promise((resolve) => setTimeout(resolve, ms))
		return
	}
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		const onAbort = () => {
			clearTimeout(timer)
			reject(new DOMException('The publish attempt was aborted.', 'AbortError'))
		}
		signal.addEventListener('abort', onAbort, { once: true })
	})
}

const checkSchema = z.object({
	kind: z.enum([
		'manifest',
		'docs',
		'skills',
		'dependencies',
		'bundle',
		'typecheck',
		'lint',
		'credentials',
		'smoke',
	]),
	ok: z.boolean(),
	message: z.string(),
})

const staticDependentItemSchema = z
	.object({
		package_id: z
			.string()
			.describe('Saved package id of the dependent package.'),
		kody_id: z.string().describe('Package name leaf of the dependent package.'),
		name: z
			.string()
			.describe('Scoped package.json name of the dependent package.'),
		source_id: z
			.string()
			.describe('Repo-backed source id for the dependent package.'),
		published_commit: z
			.string()
			.nullable()
			.describe('Current published commit of the dependent package.'),
		stale: z
			.boolean()
			.describe(
				"True when at least one dependent bundle artifact captured a dependency commit that differs from the package's current published commit.",
			),
		artifact_count: z
			.number()
			.int()
			.nonnegative()
			.describe(
				'Number of published bundle artifacts that reference this dependency.',
			),
		entrypoints: z
			.array(z.string())
			.describe(
				'Bounded list of dependent bundle entrypoints referencing this dependency.',
			),
		entrypoints_truncated: z
			.boolean()
			.describe(
				'True when the dependent has more matching entrypoints than returned.',
			),
		bundled_dependency_commit: z
			.string()
			.nullable()
			.describe(
				'Dependency commit captured in the dependent bundle, or null when matching artifacts have mixed or missing commits.',
			),
		current_dependency_commit: z
			.string()
			.describe(
				'Current published commit for the referenced dependency package.',
			),
		recommended_action: z
			.string()
			.describe('Agent guidance for this dependent package.'),
	})
	.describe('A direct static dependent package from persisted bundle metadata.')

const staticDependentsSchema = z
	.object({
		total: z
			.number()
			.int()
			.nonnegative()
			.describe('Total direct static dependent packages found.'),
		stale: z
			.number()
			.int()
			.nonnegative()
			.describe(
				'Count of direct static dependent packages with stale bundled snapshots.',
			),
		truncated: z
			.boolean()
			.describe(
				'True when more dependent packages exist than are returned in items.',
			),
		items: z
			.array(staticDependentItemSchema)
			.describe('Bounded direct static dependent package summaries.'),
		recommended_next_action: z
			.string()
			.describe(
				'Agent guidance explaining whether to inspect or republish dependents. Kody does not republish dependents automatically.',
			),
	})
	.describe(
		'Bounded summary of saved packages whose published bundles statically captured this package through kody:@ imports.',
	)

const packageTestHintsSchema = z.object({
	app: z.string().optional(),
	subscriptions: z
		.array(
			z.object({
				topic: z.string(),
				snippet: z.string(),
			}),
		)
		.optional(),
	enablements: z
		.object({
			message: z
				.string()
				.describe(
					'Agent-directed message: ask the user whether to enable each listed trigger, with the exact enablementEnable call (or Approve for webhooks/email).',
				),
			triggers: z.array(
				z.object({
					kind: z.enum(['cron', 'subscription', 'webhook']),
					name: z.string(),
					reason: z.enum(['missing', 'paused']),
					call: z
						.string()
						.nullable()
						.describe(
							'Exact enablementEnable call when applicable; null for Approve-only triggers.',
						),
				}),
			),
		})
		.optional(),
})

const publishPhaseTimingsSchema = z
	.object({
		clone_ms: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe(
				'Milliseconds spent cloning Artifacts HEAD into the publish workspace. Omitted when this attempt did not clone.',
			),
		checks_typecheck_ms: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe(
				'Milliseconds spent in the publish typecheck phase. Omitted when typecheck did not run (for example already_published).',
			),
		checks_bundle_ms: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe(
				'Milliseconds spent in the publish bundle-check phase. Distinct from rebuild_ms. Omitted when bundle check did not run, including when full esbuild validation is deferred to rebuild.',
			),
		rebuild_ms: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe(
				'Milliseconds spent rebuilding published package artifacts after checks, or confirming they match this commit. Distinct from checks_bundle_ms.',
			),
		dependents_ms: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe(
				'Milliseconds spent indexing static dependents, hosted app URL, test hints, and pending secret approvals.',
			),
		total_ms: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe(
				'Milliseconds from the start of this publish attempt until the result was ready. On status dispatched, this is time-to-dispatch.',
			),
	})
	.describe(
		'Coarse packagePublishExternalPush phase timings in milliseconds. Field names are stable. Omitted keys mean that phase did not run in this result. checks_bundle_ms and rebuild_ms stay separate.',
	)

const communityListingBehindHintSchema = z
	.object({
		pinnedVersion: z.string().nullable(),
		promotedVersion: z.string().nullable(),
		behind: z.literal(true),
		updateHint: z.string(),
		updateUrl: z.string(),
	})
	.describe(
		'Present when this package has a public community listing whose pinned snapshot is still behind the published commit after promote auto-sync. Rare; a background backfill retries. No manual republish step is required.',
	)

const outputSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('already_published'),
		published_commit: z.string().nullable(),
		hosted_app_url: z.string().nullable(),
		test_hints: packageTestHintsSchema.optional(),
		static_dependents: staticDependentsSchema,
		pending_secret_package_approvals: pendingPackageSecretApprovalsSchema,
		listing: communityListingBehindHintSchema.optional(),
		phase_timings: publishPhaseTimingsSchema,
	}),
	z.object({
		status: z.literal('not_fast_forward'),
		previous_commit: z.string(),
		published_commit: z.string(),
		message: z.string(),
	}),
	z.object({
		status: z.literal('locked'),
		previous_commit: z.string().nullable(),
		pending_commit: z
			.string()
			.describe(
				'HEAD commit that passed checks. Promote it on the website approval page.',
			),
		approval_url: z.string(),
		message: z.string(),
	}),
	z.object({
		status: z.literal('approval_required'),
		previous_commit: z.string().nullable(),
		pending_commit: z
			.string()
			.describe(
				'HEAD commit that passed checks. The previously published commit keeps serving until the owner approves this one.',
			),
		approval_url: z.string(),
		approval_bundle_url: z
			.string()
			.optional()
			.describe(
				'Present when other paused publishes also wait on the owner: one page that approves them together.',
			),
		credential_need_changes: z.array(credentialNeedChangeSchema),
		message: z.string(),
	}),
	z.object({
		status: z.literal('checks_failed'),
		failed_checks: z.array(checkSchema),
		manifest: z
			.unknown()
			.nullable()
			.describe(
				'Parsed package.json when available; null when the manifest itself failed validation or was missing.',
			),
		run_id: z.string(),
	}),
	z.object({
		status: z.literal('published'),
		previous_commit: z.string().nullable(),
		published_commit: z.string(),
		manifest: z.unknown(),
		checks: z.array(checkSchema),
		hosted_app_url: z.string().nullable(),
		test_hints: packageTestHintsSchema.optional(),
		static_dependents: staticDependentsSchema,
		pending_secret_package_approvals: pendingPackageSecretApprovalsSchema,
		listing: communityListingBehindHintSchema.optional(),
		phase_timings: publishPhaseTimingsSchema,
	}),
	z.object({
		status: z.literal('dispatched'),
		workflow_id: z.string(),
		workflow_name: z.string(),
		idempotency_key: z.string(),
		run_status: z.string().nullable(),
		message: z.string(),
		phase_timings: publishPhaseTimingsSchema,
	}),
])

type PublishExternalPushResult = z.infer<typeof outputSchema>

function buildPublishPhaseTimings(input: {
	startedAt: number
	fromPublish?: PublishPhaseTimings
	rebuildMs: number
	dependentsMs: number
}): PublishPhaseTimings {
	return withPublishAttemptTotalMs(
		mergePublishPhaseTimings(input.fromPublish, {
			rebuild_ms: input.rebuildMs,
			dependents_ms: input.dependentsMs,
		}),
		input.startedAt,
	)
}

function readPackageTestHintsFromManifest(input: {
	manifest: unknown
	packageId: string
	kodyId?: string | null
	enablementTriggers?: ReadonlyArray<EnablementHintTrigger>
}): PackageTestHints | undefined {
	const { manifest } = input
	if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
		return undefined
	}
	const kody = Reflect.get(manifest, 'kody')
	if (!kody || typeof kody !== 'object' || Array.isArray(kody)) return undefined
	const subscriptions = Reflect.get(kody, 'subscriptions')
	return buildPackageTestHints({
		packageId: input.packageId,
		kodyId: input.kodyId,
		hasApp: Reflect.get(kody, 'app') !== undefined,
		subscriptionTopics:
			subscriptions &&
			typeof subscriptions === 'object' &&
			!Array.isArray(subscriptions)
				? Object.keys(subscriptions)
				: [],
		enablementTriggers: input.enablementTriggers,
	})
}

async function resolvePublishEnablementTriggers(input: {
	env: Env
	baseUrl: string
	ownerUserId: OwnerId
	packageId: string
	publisherUserId: string
}) {
	try {
		return await listPublisherEnablementGaps({
			env: input.env,
			baseUrl: input.baseUrl,
			ownerUserId: input.ownerUserId,
			packageId: input.packageId,
			publisherUserId: personIdFromStored(input.publisherUserId),
		})
	} catch (error) {
		console.warn('publish-enablement-gaps-failed', error)
		return []
	}
}

async function getPublishedPackageTestHints(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	sourceId: string
	packageId: string
	kodyId: string
	publisherUserId: string
}) {
	try {
		const published = await loadPublishedEntitySource({
			env: input.env,
			userId: input.userId,
			sourceId: input.sourceId,
		})
		const packageJson = published.files['package.json']
		if (!packageJson) return undefined
		const enablementTriggers = await resolvePublishEnablementTriggers({
			env: input.env,
			baseUrl: input.baseUrl,
			ownerUserId: input.userId,
			packageId: input.packageId,
			publisherUserId: input.publisherUserId,
		})
		return readPackageTestHintsFromManifest({
			manifest: JSON.parse(packageJson),
			packageId: input.packageId,
			kodyId: input.kodyId,
			enablementTriggers,
		})
	} catch {
		return undefined
	}
}

async function resolvePublishedHostedAppUrl(input: {
	env: Env
	baseUrl: string
	ownerScope: string
	ownerEmail: string
	kodyId: string
	hasApp: boolean
}) {
	if (!input.hasApp) return null
	const username = await resolvePublicUsername({
		db: input.env.APP_DB,
		username: input.ownerScope,
		email: input.ownerEmail,
	})
	if (!username) return null
	return resolveHostedPackageAppUrl({
		packageAppBaseUrl: getPackageAppBaseUrl({ env: input.env }),
		appBaseUrl: input.baseUrl,
		username,
		kodyId: input.kodyId,
	})
}

function readSecretMountsFromPackageJson(content: string | undefined) {
	if (!content) return null
	try {
		const parsed = JSON.parse(content) as {
			kody?: {
				secretMounts?: Record<
					string,
					{ name: string; scope?: 'user' | 'package' | 'session' }
				>
			}
		}
		const mounts = parsed.kody?.secretMounts
		if (!mounts || typeof mounts !== 'object') return null
		return mounts
	} catch {
		return null
	}
}

async function getPendingSecretApprovalsForPublishedPackage(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	orgSlug?: string | null
	packageId: string
	kodyId: string
	sourceId: string
}): Promise<PendingPackageSecretApprovalsSummary | null> {
	try {
		const published = await loadPublishedEntitySource({
			env: input.env,
			userId: input.userId,
			sourceId: input.sourceId,
		})
		return await buildPendingPackageSecretApprovalsSummary({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			orgSlug: input.orgSlug,
			packageId: input.packageId,
			kodyId: input.kodyId,
			secretMounts: readSecretMountsFromPackageJson(
				published.files['package.json'],
			),
			files: published.files,
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: input.packageId,
				storageId: null,
			},
		})
	} catch {
		return null
	}
}

async function getListingBehindPublishHint(input: {
	env: Env
	baseUrl: string
	ownerUserId: OwnerId
	ownerScope: string
	packageId: string
	kodyId: string
	promotedCommit: string
	promotedVersion?: string | null
}) {
	// Optional discoverability only — never fail a completed publish/promote
	// because the listing hint lookup rejected.
	try {
		const path = buildUpdatePublicListingHref({
			username: input.ownerScope,
			kodyId: input.kodyId,
		})
		const updateUrl = new URL(path, input.baseUrl).toString()
		return await resolveListingBehindPublishHint({
			db: input.env.APP_DB,
			ownerUserId: input.ownerUserId,
			packageId: input.packageId,
			ownerUsername: input.ownerScope,
			kodyId: input.kodyId,
			promotedCommit: input.promotedCommit,
			promotedVersion: input.promotedVersion,
			updateUrl,
		})
	} catch (error) {
		console.warn(
			`[packagePublishExternalPush] listing hint lookup failed for ${input.ownerScope}/${input.kodyId}:`,
			error instanceof Error ? error.message : error,
		)
		return null
	}
}

async function getPublishStaticDependents(input: {
	env: Env
	userId: OwnerId
	sourceId: string
	publishedCommit: string | null
	previousCommit?: string | null
}): Promise<StaticPackageDependentsSummary> {
	if (!input.publishedCommit) {
		return {
			total: 0,
			stale: 0,
			truncated: false,
			items: [],
			recommended_next_action:
				'No published commit is available, so static dependent bundle metadata cannot be compared.',
		}
	}
	const summary = await getStaticPackageDependentsSummary({
		db: input.env.APP_DB,
		userId: input.userId,
		sourceId: input.sourceId,
		currentDependencyCommit: input.publishedCommit,
	})
	return await annotateStaticDependentsWithSecretMounts({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
		nextCommit: input.publishedCommit,
		summary,
		previousCommit: input.previousCommit,
	})
}

/**
 * Every input that changes publish semantics for durable dedupe. Adding a
 * field here is a compile-time break at the call site that builds this object,
 * and the canonical JSON blob below includes every property automatically.
 */
export type ExternalPublishSemanticInput = {
	ownerUserId: OwnerId
	packageId: string
	newCommit: string
	allowForce: boolean
	destructiveOverwriteConfirmed: boolean
}

export function buildExternalPublishIdempotencyParts(
	input: ExternalPublishSemanticInput,
) {
	// Caller identity is applied by runWithDurableEscalation (RunLog workflow
	// projections are user-scoped). Distinct delegates may each dispatch for
	// the same publish; that is safe because re-invoking publish when
	// published_commit already matches HEAD returns already_published without
	// checks or D1 writes. Active and succeeded durable runs still dedupe on
	// this key; a terminal failure releases it so the same commit can publish
	// again (for example after a Durable Object reset mid-run).
	return ['packagePublishExternalPush', canonicalJsonStringify(input)] as const
}

function shouldEscalateExternalPublish(executionOrigin: string | undefined) {
	// Fail closed: only interactive MCP calls escalate. Missing origin and
	// background (durable workflow re-entry) must not create another workflow.
	// package-workflows invokeInlineWorkflowCode always sets background today;
	// requiring an explicit interactive origin still prevents a self-replicating
	// chain if any future path forgets to set it.
	return executionOrigin === 'interactive'
}

async function runExternalPublishAttempt(input: {
	env: Env
	baseUrl: string
	ownerUserId: OwnerId
	ownerScope: string
	orgSlug?: string | null
	ownerEmail: string
	expectedPackageScope: string
	packageId: string
	kodyId: string
	hasApp: boolean
	source: {
		id: string
		repo_id: string
	}
	newCommit: string
	allowForce: boolean
	destructiveOverwriteConfirmed: boolean
	requestedByUserId: string | null
	approvalViewer: ApprovalViewer | null
	signal?: AbortSignal
	reportProgress?: McpReportProgress
}): Promise<Exclude<PublishExternalPushResult, { status: 'dispatched' }>> {
	const maxAttempts = externalPublishRetryDelaysMs.length + 1
	let lastTransientError: unknown = null
	for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
		assertNotAborted(input.signal)
		const attempt = attemptIndex + 1
		const sessionId =
			attemptIndex === 0
				? `external-publish-${input.source.id}`
				: `external-publish-${input.source.id}-retry-${attempt}`
		try {
			await reportCapabilityProgress(input.reportProgress, {
				progress: attempt,
				total: maxAttempts + 1,
				message:
					attempt === 1
						? 'Publishing from Artifacts HEAD — cloning, checking, and promoting the commit…'
						: `Publish attempt ${attempt}/${maxAttempts} — giving the repo another nudge…`,
			})
			const publishStartedAt = Date.now()
			const result = await repoSessionRpc(
				input.env,
				sessionId,
			).publishFromExternalRef({
				sessionId,
				sourceId: input.source.id,
				userId: input.ownerUserId,
				newCommit: input.newCommit,
				expectedHead: input.newCommit,
				allowForce: input.allowForce,
				destructiveOverwriteConfirmed: input.destructiveOverwriteConfirmed,
				baseUrl: input.baseUrl,
				rebuildPackageArtifacts: false,
				expectedPackageScope: input.expectedPackageScope,
				requestedByUserId: input.requestedByUserId,
				deferBundleCheckToRebuild: true,
			})
			const publishMs = Date.now() - publishStartedAt
			assertNotAborted(input.signal)
			if (result.status === 'already_published') {
				const publishedCommit = result.published_commit
				if (!publishedCommit) {
					throw new Error(
						`Package "${input.packageId}" is already published, but no published commit is available to rebuild artifacts.`,
					)
				}
				const forceRebuild = result.force_artifact_rebuild === true
				await reportCapabilityProgress(input.reportProgress, {
					progress: maxAttempts + 1,
					total: maxAttempts + 1,
					message: forceRebuild
						? `Already published after ${publishMs}ms — snapshot changed, rebuilding artifacts…`
						: `Already published after ${publishMs}ms — confirming artifacts match this commit…`,
				})
				const { durationMs: rebuildMs, value: rebuildOutcome } =
					await timePublishExternalPushPhase(
						{
							phase: 'rebuild',
							sourceId: input.source.id,
							publishedCommit,
						},
						async () => {
							try {
								await rebuildPublishedPackageArtifactsViaRepoSession({
									env: input.env,
									rpcSessionId: sessionId,
									sourceId: input.source.id,
									userId: input.ownerUserId,
									publishedCommit,
									baseUrl: input.baseUrl,
									...(forceRebuild ? { force: true } : {}),
								})
								return { ok: true as const }
							} catch (error) {
								if (isTransientDurableObjectResetError(error)) {
									throw error
								}
								return {
									ok: false as const,
									failedCheck: bundleCheckFailedFromRebuildError(error),
								}
							}
						},
					)
				if (!rebuildOutcome.ok) {
					return {
						status: 'checks_failed' as const,
						failed_checks: [rebuildOutcome.failedCheck],
						manifest: null,
						run_id: crypto.randomUUID(),
					}
				}
				const { durationMs: dependentsMs, value: alreadyPublishedExtras } =
					await timePublishExternalPushPhase(
						{
							phase: 'dependents',
							sourceId: input.source.id,
							publishedCommit,
						},
						async () => {
							const [testHints, listing] = await Promise.all([
								getPublishedPackageTestHints({
									env: input.env,
									baseUrl: input.baseUrl,
									userId: input.ownerUserId,
									sourceId: input.source.id,
									packageId: input.packageId,
									kodyId: input.kodyId,
									publisherUserId: input.requestedByUserId ?? input.ownerUserId,
								}),
								getListingBehindPublishHint({
									env: input.env,
									baseUrl: input.baseUrl,
									ownerUserId: input.ownerUserId,
									ownerScope: input.ownerScope,
									packageId: input.packageId,
									kodyId: input.kodyId,
									promotedCommit: publishedCommit,
								}),
							])
							return {
								testHints,
								listing,
								hosted_app_url: await resolvePublishedHostedAppUrl({
									env: input.env,
									baseUrl: input.baseUrl,
									ownerScope: input.ownerScope,
									ownerEmail: input.ownerEmail,
									kodyId: input.kodyId,
									hasApp: input.hasApp,
								}),
								static_dependents: await getPublishStaticDependents({
									env: input.env,
									userId: input.ownerUserId,
									sourceId: input.source.id,
									publishedCommit,
								}),
								pending_secret_package_approvals:
									await getPendingSecretApprovalsForPublishedPackage({
										env: input.env,
										baseUrl: input.baseUrl,
										userId: input.ownerUserId,
										orgSlug: input.orgSlug,
										packageId: input.packageId,
										kodyId: input.kodyId,
										sourceId: input.source.id,
									}),
							}
						},
					)
				await reportCapabilityProgress(input.reportProgress, {
					progress: maxAttempts + 1,
					total: maxAttempts + 1,
					message: `Already published wrap-up — rebuild ${rebuildMs}ms, dependents ${dependentsMs}ms.`,
				})
				return {
					status: 'already_published' as const,
					published_commit: publishedCommit,
					hosted_app_url: alreadyPublishedExtras.hosted_app_url,
					...(alreadyPublishedExtras.testHints
						? { test_hints: alreadyPublishedExtras.testHints }
						: {}),
					static_dependents: alreadyPublishedExtras.static_dependents,
					pending_secret_package_approvals:
						alreadyPublishedExtras.pending_secret_package_approvals,
					...(alreadyPublishedExtras.listing
						? { listing: alreadyPublishedExtras.listing }
						: {}),
					phase_timings: buildPublishPhaseTimings({
						startedAt: publishStartedAt,
						fromPublish: result.phase_timings,
						rebuildMs,
						dependentsMs,
					}),
				}
			}
			if (result.status === 'locked') {
				const approvalUrl = buildPackagePublishApprovalUrl({
					baseUrl: input.baseUrl,
					username: input.ownerScope,
					kodyId: input.kodyId,
					commit: result.pending_commit,
				})
				return {
					status: 'locked' as const,
					previous_commit: result.previous_commit,
					pending_commit: result.pending_commit,
					approval_url: approvalUrl,
					message: appendSecretMountCompatNotice(
						createPackagePublishLockedMessage({
							packageName: result.packageName,
							approvalUrl,
						}),
						result.secret_mount_compat,
					),
				}
			}
			if (result.status === 'approval_required') {
				const approvalUrl = buildPackageCapabilityApprovalUrl({
					baseUrl: input.baseUrl,
					username: input.ownerScope,
					kodyId: input.kodyId,
				})
				const bundle = await bundlePausedPublishes({
					viewer: input.approvalViewer,
					ownerUserId: input.ownerUserId,
				})
				const message = createCredentialNeedsApprovalMessage({
					packageName: result.approval.packageName,
					changes: result.approval.changes,
					approvalUrl,
				})
				const approvalMessage = bundle
					? `${message} ${pausedPublishBundleMessage(bundle)}`
					: message
				return {
					status: 'approval_required' as const,
					previous_commit: result.previous_commit,
					pending_commit: result.pending_commit,
					approval_url: approvalUrl,
					...(bundle ? { approval_bundle_url: bundle.url } : {}),
					credential_need_changes: result.approval.changes,
					message: appendSecretMountCompatNotice(
						approvalMessage,
						result.secret_mount_compat,
					),
				}
			}
			if (result.status !== 'published') {
				return result
			}
			await reportCapabilityProgress(input.reportProgress, {
				progress: maxAttempts + 1,
				total: maxAttempts + 1,
				message: `Checks passed in ${publishMs}ms — rebuilding published artifacts and indexing dependents…`,
			})
			const { durationMs: rebuildMs, value: rebuildOutcome } =
				await timePublishExternalPushPhase(
					{
						phase: 'rebuild',
						sourceId: input.source.id,
						publishedCommit: result.published_commit,
					},
					async () => {
						try {
							await rebuildPublishedPackageArtifactsViaRepoSession({
								env: input.env,
								rpcSessionId: sessionId,
								sourceId: input.source.id,
								userId: input.ownerUserId,
								publishedCommit: result.published_commit,
								baseUrl: input.baseUrl,
							})
							return { ok: true as const }
						} catch (error) {
							if (isTransientDurableObjectResetError(error)) {
								throw error
							}
							return {
								ok: false as const,
								failedCheck: bundleCheckFailedFromRebuildError(error),
							}
						}
					},
				)
			if (!rebuildOutcome.ok) {
				return {
					status: 'checks_failed' as const,
					failed_checks: [rebuildOutcome.failedCheck],
					manifest: result.manifest ?? null,
					run_id: crypto.randomUUID(),
				}
			}
			const { durationMs: dependentsMs, value: publishedExtras } =
				await timePublishExternalPushPhase(
					{
						phase: 'dependents',
						sourceId: input.source.id,
						publishedCommit: result.published_commit,
					},
					async () => {
						const enablementTriggers = await resolvePublishEnablementTriggers({
							env: input.env,
							baseUrl: input.baseUrl,
							ownerUserId: input.ownerUserId,
							packageId: input.packageId,
							publisherUserId: input.requestedByUserId ?? input.ownerUserId,
						})
						const testHints = readPackageTestHintsFromManifest({
							manifest: result.manifest,
							packageId: input.packageId,
							kodyId: input.kodyId,
							enablementTriggers,
						})
						const listing = await getListingBehindPublishHint({
							env: input.env,
							baseUrl: input.baseUrl,
							ownerUserId: input.ownerUserId,
							ownerScope: input.ownerScope,
							packageId: input.packageId,
							kodyId: input.kodyId,
							promotedCommit: result.published_commit,
							promotedVersion: readPromotedVersionFromManifest(result.manifest),
						})
						return {
							testHints,
							listing,
							hosted_app_url: await resolvePublishedHostedAppUrl({
								env: input.env,
								baseUrl: input.baseUrl,
								ownerScope: input.ownerScope,
								ownerEmail: input.ownerEmail,
								kodyId: input.kodyId,
								hasApp: Boolean(testHints?.app),
							}),
							static_dependents: await getPublishStaticDependents({
								env: input.env,
								userId: input.ownerUserId,
								sourceId: input.source.id,
								publishedCommit: result.published_commit,
								previousCommit: result.previous_commit,
							}),
							pending_secret_package_approvals:
								await getPendingSecretApprovalsForPublishedPackage({
									env: input.env,
									baseUrl: input.baseUrl,
									userId: input.ownerUserId,
									orgSlug: input.orgSlug,
									packageId: input.packageId,
									kodyId: input.kodyId,
									sourceId: input.source.id,
								}),
						}
					},
				)
			await reportCapabilityProgress(input.reportProgress, {
				progress: maxAttempts + 1,
				total: maxAttempts + 1,
				message: `Published wrap-up — rebuild ${rebuildMs}ms, dependents ${dependentsMs}ms.`,
			})
			return {
				...result,
				hosted_app_url: publishedExtras.hosted_app_url,
				...(publishedExtras.testHints
					? { test_hints: publishedExtras.testHints }
					: {}),
				static_dependents: publishedExtras.static_dependents,
				pending_secret_package_approvals:
					publishedExtras.pending_secret_package_approvals,
				...(publishedExtras.listing
					? { listing: publishedExtras.listing }
					: {}),
				phase_timings: buildPublishPhaseTimings({
					startedAt: publishStartedAt,
					fromPublish: result.phase_timings,
					rebuildMs,
					dependentsMs,
				}),
			} as const
		} catch (error) {
			assertNotAborted(input.signal)
			if (!isTransientDurableObjectResetError(error)) {
				throw error
			}
			lastTransientError = error
			const willRetry = attemptIndex < externalPublishRetryDelaysMs.length
			const nextDelayMs = willRetry
				? (externalPublishRetryDelaysMs[attemptIndex] ?? 0)
				: 0
			logExternalPublishRetry({
				sourceId: input.source.id,
				repoId: input.source.repo_id,
				packageId: input.packageId,
				newCommit: input.newCommit,
				attempt,
				nextDelayMs,
				error,
			})
			if (!willRetry) {
				break
			}
			await delay(nextDelayMs, input.signal)
		}
	}
	throw new Error(
		`packagePublishExternalPush could not recover after ${maxAttempts} transient Durable Object reset attempts: ${getErrorMessage(
			lastTransientError,
		)}`,
	)
}

export const publishExternalPushCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packagePublishExternalPush',
		orgPermission: 'package:write',
		description:
			'Publish the current Artifacts git HEAD for a saved package after a packageGetGitRemote clone/edit/push workflow and server-side checks pass. Non-fast-forward publishes require explicit destructive overwrite confirmation and a verified restorable backup snapshot. Full check-time esbuild is deferred to the published artifact rebuild so callable and importable targets are bundled once; unchanged targets are copied from the previous published commit when their reachable inputs match, and a rebuild failure returns checks_failed with a bundle check. Published and already_published responses include hosted_app_url when the package declares an app, plus bounded static dependent metadata so agents can decide whether stale kody:@ bundled snapshots need inspection or dependent republish; Kody does not republish dependents automatically. Those success results also include phase_timings with optional millisecond fields clone_ms, checks_typecheck_ms, checks_bundle_ms, rebuild_ms, dependents_ms, and total_ms — omitted keys did not run; checks_bundle_ms is omitted when bundle validation is deferred to rebuild; checks_bundle_ms and rebuild_ms stay separate. Common cases return the full synchronous result. If the publish exceeds the inline budget (~35s), the work is dispatched once to a durable workflow (idempotent per acting caller plus the full semantic publish input, including force/overwrite flags) and this capability returns status dispatched with a workflow_id to poll via workflowRunList instead of hanging until an opaque execute timeout. Active and succeeded durable runs still dedupe; a terminal failure (for example Durable Object reset because its code was updated) releases the idempotency key so the same commit can be published again. dispatched includes phase_timings.total_ms as time-to-dispatch.',
		keywords: ['package', 'publish', 'git', 'artifacts', 'external', 'push'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const expectedPackageScope = owner.ownerScope
			const { packageId, userId, kodyId, hasApp, name, source } =
				await resolveOwnedPackageSource({
					db: ctx.env.APP_DB,
					userId: owner.ownerUserId,
					ownerScope: owner.ownerScope,
					args: {
						package_id: args.package_id,
						kody_id: args.kody_id,
					},
				})
			await authorizePackageWrite(
				{ env: ctx.env, request: ctx.callerContext.request },
				{ id: packageId, userId, label: name },
			)
			const head = await resolveArtifactSourceHead(ctx.env, source.repo_id)
			const newCommit = head.commit
			if (!newCommit) {
				throw new Error(
					`Artifacts repo "${source.repo_id}" has no published HEAD to reconcile.`,
				)
			}

			const publishInput = {
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				ownerUserId: owner.ownerUserId,
				ownerScope: owner.ownerScope,
				orgSlug: secretPageOrgSlugFromCaller(ctx.callerContext),
				ownerEmail: owner.ownerEmail,
				expectedPackageScope,
				packageId,
				kodyId,
				hasApp,
				source: { id: source.id, repo_id: source.repo_id },
				newCommit,
				allowForce: args.allow_force,
				destructiveOverwriteConfirmed: args.confirm_destructive_overwrite,
				requestedByUserId: user.userId,
				approvalViewer: optionalApprovalViewerForCaller(ctx),
				reportProgress: ctx.reportProgress,
			}

			if (!shouldEscalateExternalPublish(ctx.callerContext.executionOrigin)) {
				return await runExternalPublishAttempt(publishInput)
			}

			const semanticInput = {
				ownerUserId: owner.ownerUserId,
				packageId,
				newCommit,
				allowForce: args.allow_force,
				destructiveOverwriteConfirmed: args.confirm_destructive_overwrite,
			} satisfies ExternalPublishSemanticInput
			const durableParams = {
				...(args.package_id ? { package_id: args.package_id } : {}),
				...(args.kody_id ? { kody_id: args.kody_id } : {}),
				allow_force: args.allow_force,
				confirm_destructive_overwrite: args.confirm_destructive_overwrite,
			}
			const escalateStartedAt = Date.now()
			// Key the durable re-entry to the package-owning org, not the actor's
			// personal org. Team publishes (`@kody`, …) otherwise re-bind to the
			// actor personal org and fail mid-rebuild after git accepted the push.
			const outcome = await runWithDurableEscalation({
				env: ctx.env,
				userId: owner.ownerUserId,
				userEmail: packageOwnerEntitlementEmail(owner),
				lineage: requestLineage(requireMcpRequest(ctx.callerContext)),
				budgetMs: defaultDurableEscalationBudgetMs,
				idempotencyParts: buildExternalPublishIdempotencyParts(semanticInput),
				workflowName: 'packagePublishExternalPush',
				packageContext: {
					packageId,
					kodyId,
					sourceId: source.id,
				},
				durableCode: durablePublishWorkflowCode,
				durableParams,
				run: async (signal) =>
					await runExternalPublishAttempt({
						...publishInput,
						signal,
					}),
			})

			switch (outcome.kind) {
				case 'completed':
					return outcome.value
				case 'dispatched':
					return {
						...outcome.handle,
						phase_timings: withPublishAttemptTotalMs({}, escalateStartedAt),
					}
				case 'failed':
					// Preserve typed errors (EntitlementLimitError, …) for toApiError.
					if (outcome.error instanceof Error) throw outcome.error
					throw new Error(getErrorMessage(outcome.error))
				default: {
					const exhaustive: never = outcome
					throw new Error(
						`Unexpected durable escalation outcome: ${JSON.stringify(exhaustive)}`,
					)
				}
			}
		},
	},
)
