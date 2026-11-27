import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import { showBuildOrigin } from '#worker/publish-offload/policy.ts'
import {
	resolveUploadedPublishBuildForPublish,
	type UploadedPublishBuildRef,
} from '#worker/publish-offload/store.ts'
import {
	type OwnerId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { durablePublishWorkflowCode } from '#worker/package-runtime/durable-publish-result.ts'
import { repoCheckKinds } from '#worker/repo/checks.ts'
import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import { resolveHostedPackageAppUrl } from '@kody-internal/shared/public-urls.ts'
import { resolvePublicPackageAppLocation } from '#worker/package-app-public-url.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { readLastCheckStep } from '#worker/repo/isolated-check-phases.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { dispatchDurableRun } from '#mcp/capabilities/durable-escalation.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import * as Sentry from '@sentry/cloudflare'
import {
	isDurableObjectIsolateResourceLimitResetError,
	isTransientDurableObjectResetError,
} from '#worker/durable-object-reset-retry.ts'
import { notePackageAppPublishRequester } from '#worker/package-runtime/package-app-authority.ts'
import { isExternalPublishSnapshotTooLargeMessage } from '#worker/repo/external-publish-clone.ts'
import {
	externalPublishResourceLimitMessage,
	isPublishComputeLimitMessage,
	type RepoCheckStep,
} from '#worker/repo/isolated-runner-limit-message.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import {
	getPackageNameLeaf,
	packageIdLookupDescription,
	packageKodyIdOptionalInput,
	packageNameLookupDescription,
} from '#worker/package-registry/package-name.ts'
import { authorizePackageWrite } from '#worker/authorization/authorize.ts'
import {
	knownUnmappableCredentials,
	loadOnePackageUnmappableCredentials,
	unmappableCredentialOwnerNotice,
} from '#worker/credentials/package-unmappable-credentials.ts'
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
import type { EnablementHintTrigger } from '#worker/enablements/enablement-agent-hints.ts'
import { listPublisherEnablementGaps } from '#worker/enablements/publisher-enablement-gaps.ts'
import {
	buildPackageTestHints,
	type PackageTestHints,
} from '#worker/package-registry/package-test-hints.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import { buildArtifactsHeadChangedBeforePublishMessage } from '#worker/repo/publish-concurrency-caller-error.ts'
import { assertPackagePublishCurrent } from '#mcp/capabilities/repo/assert-package-publish-current.ts'
import { rebuildPublishedPackageArtifactsViaRepoSession } from '#mcp/capabilities/repo/package-artifact-rebuild.ts'
import { settleFailedPublishRebuild } from '#mcp/capabilities/repo/settle-failed-publish-rebuild.ts'
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
import { buildCredentialAllowedPackagesPublishWarningNotice } from '#worker/credentials/credential-allowed-packages-publish-warning.ts'
import { loadPublishedEntitySource } from '#worker/repo/published-source.ts'
import {
	buildPackagePublishApprovalUrl,
	createPackagePublishLockedMessage,
} from '#worker/package-registry/package-publish-lock.ts'
import { buildPackageCapabilityApprovalUrl } from '#worker/package-capabilities/capability-approval-url.ts'
import { createCredentialNeedsApprovalMessage } from '#worker/credentials/credential-needs-approval.ts'
import type { ApprovalViewer } from '#worker/approval-bundles/item-views.ts'
import {
	bundlePausedPublishes,
	pausedPublishBundleMessage,
} from '#worker/approval-bundles/paused-publishes.ts'
import { optionalApprovalViewerForCaller } from './approval-bundle-shared.ts'
import {
	heldForApprovalStatusDescription,
	heldForApprovalStatusShape,
	loadHeldForApprovalPublishStatus,
	type HeldForApprovalPublishStatus,
} from './held-for-approval-publish-status.ts'
import {
	credentialNeedChangeSchema,
	pendingPackageSecretApprovalsSchema,
} from './shared.ts'
import { resolveOwnedPackageSource } from './resolve-package-source.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	reportCapabilityProgress,
	type McpReportProgress,
} from '#mcp/progress.ts'
import { isUserCodeError } from '#worker/user-code-error.ts'
import {
	readPromotedVersionFromManifest,
	resolveListingBehindPublishHint,
} from '#worker/community/resolve-listing-behind-publish-hint.ts'
import { buildUpdatePublicListingHref } from '#universal/update-public-listing.ts'
import {
	decidePublishRoute,
	publishRouteDeps,
} from '#worker/publish-offload/publish-routing.ts'

const inputSchema = z.object({
	package_id: z.string().min(1).optional().describe(packageIdLookupDescription),
	name: z.string().min(1).optional().describe(packageNameLookupDescription),
	kody_id: packageKodyIdOptionalInput(),
	allow_force: z.boolean().optional().default(false),
	confirm_destructive_overwrite: z
		.boolean()
		.optional()
		.default(false)
		.describe(destructiveOverwriteConfirmationDescription),
	/**
	 * Tip at the start of the interactive publish request that dispatched the
	 * durable workflow. Honored only when executionOrigin is background
	 * (durable re-entry). Interactive callers are ignored so a null/spoofed
	 * optional field cannot force published for a true no-op tip. The
	 * capability stamps this into durableParams; agents must not set it.
	 */
	baseline_published_commit: z.string().nullable().optional(),
	/** The Artifacts HEAD this durable run was enqueued for. */
	expected_head: z.string().min(1).optional(),
	publish_build_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Publish offload (publish-offload flag): the id of a publish build whose bundles were built by the Kody CLI or an execution context and uploaded for this exact commit. The server re-runs the cheap checks, verifies the uploaded tree and bundles, and only then serves the commit. Set by `kody package publish --build local|context`; agents should not set it by hand.',
		),
	context: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe(
			'Execution context name or id to build this publish on, or "cloud" (execution-contexts and publish-offload flags). Overrides the package\'s kody.publish.execution.context binding and your chain, and never falls back. Without it, a bound package builds only on its bound context, and any other package follows your execution context chain like execute (contexts in order, Kody cloud last unless the chain is strict).',
		),
})

const externalPublishRetryDelaysMs = [100, 500] as const

const publishBuildOriginSchema = z
	.object({
		origin: z.enum(['cloud', 'cli', 'context']),
		context_name: z.string().nullable(),
	})
	.describe(
		"Where this version was built: Kody cloud, the publisher's CLI (--build local), or one of their execution contexts (--build context).",
	)

/**
 * The person publishing. Durable re-entry runs as the package-owning org
 * (`resolveBackgroundMcpUser(payload.userId)`), so a team package's caller
 * user is the org there; the person who made the build is the lineage actor.
 */
export function publishRequesterPersonId(
	callerContext: Pick<Partial<McpCallerContext>, 'user' | 'request'>,
) {
	return (
		callerContext.request?.actor?.userId ?? requireMcpUser(callerContext).userId
	)
}

/** Memory/CPU limit errors {@link throwIfExternalPublishResourceLimit} turns terminal. */
function isExternalPublishResourceLimitError(error: unknown) {
	if (error instanceof McpCallerError) return false
	if (isDurableObjectIsolateResourceLimitResetError(error)) return true
	const message = getErrorMessage(error)
	return (
		isExternalPublishSnapshotTooLargeMessage(message) ||
		isPublishComputeLimitMessage(message)
	)
}

function throwIfExternalPublishResourceLimit(
	error: unknown,
	step: RepoCheckStep | null = null,
	offloadedBuild = false,
): never | void {
	if (error instanceof McpCallerError) throw error
	if (isDurableObjectIsolateResourceLimitResetError(error)) {
		throw new McpCallerError(
			isPublishComputeLimitMessage(getErrorMessage(error))
				? getErrorMessage(error)
				: externalPublishResourceLimitMessage(step, offloadedBuild),
			{ cause: error },
		)
	}
	const message = getErrorMessage(error)
	// A publish step that hit the limit in its own throwaway isolate: the
	// message already names the step and what to do, and a retry of the
	// same tree would hit it again.
	if (
		isExternalPublishSnapshotTooLargeMessage(message) ||
		isPublishComputeLimitMessage(message)
	) {
		throw new McpCallerError(message, { cause: error })
	}
}

function bundleCheckFailedFromRebuildError(error: unknown) {
	return {
		kind: 'bundle' as const,
		ok: false as const,
		message: getErrorMessage(error),
	}
}

function failureDuringPublishPhase(error: unknown, phase: string) {
	const ErrorType = error instanceof McpCallerError ? McpCallerError : Error
	return new ErrorType(`Failed while ${phase}: ${getErrorMessage(error)}`, {
		cause: error,
	})
}

function logExternalPublishRetry(input: {
	sourceId: string
	repoId: string
	packageId: string
	newCommit: string
	attempt: number
	nextDelayMs: number
	willRetry: boolean
	error: unknown
}) {
	// Per-attempt resets stay out of Sentry issues (exhausted retries still
	// throw and remain visible). Breadcrumb + structured warn keep CPU/memory
	// resets searchable in telemetry without opening a ticket per blip.
	const errorMessage = getErrorMessage(input.error)
	const payload = {
		message: 'packagePublishExternalPush transient Durable Object reset',
		sourceId: input.sourceId,
		repoId: input.repoId,
		packageId: input.packageId,
		newCommit: input.newCommit,
		attempt: input.attempt,
		nextDelayMs: input.nextDelayMs,
		willRetry: input.willRetry,
		errorMessage,
	}
	console.warn(JSON.stringify(payload))
	// Workers Sentry SDK exposes addBreadcrumb; unit tests may not mock it.
	if (typeof Sentry.addBreadcrumb === 'function') {
		Sentry.addBreadcrumb({
			category: 'package.publish',
			level: 'warning',
			message: payload.message,
			data: payload,
		})
	}
}

async function delay(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

const checkSchema = z.object({
	kind: z.enum(repoCheckKinds),
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

const allowedPackagesPublishNoticeSchema = z
	.string()
	.nullable()
	.optional()
	.describe(
		'Warning when this package fills a user credential whose allowed-packages list excludes it. Kody denies those uses at runtime for every package, including self-authored and adopted ones. Null/omitted when there is nothing to warn about. Does not block publish.',
	)

const artifactsRebuiltSchema = z
	.boolean()
	.describe(
		'True when this already_published result still rebuilt one or more package bundle artifacts (true no-op tip that still repaired leftovers). False when every target was already current. Only present on already_published; a tip move relative to the pre-request tip always returns published.',
	)

const checksRerunSchema = z
	.boolean()
	.optional()
	.describe(
		'True when tip already matched HEAD but publish checks were re-run because the stored check/stamp used an older checker version (or a prior attempt never sealed success). False/omitted on a true no-op (same commit, current checker, prior success).',
	)

const alreadyPublishedMessageSchema = z
	.string()
	.optional()
	.describe(
		'When checks_rerun is true, explains that same-commit checks were re-validated and the stamp refreshed. Omitted on a true no-op.',
	)

const externalPushRestoreSentryScope =
	'packagePublishExternalPush.restore-after-rebuild-failure'

/**
 * Tip moved relative to the call that dispatched this durable run. An
 * earlier attempt of the durable step may have advanced D1 before this
 * re-entry, so RepoSession tip==HEAD alone is not enough to call the result a
 * no-op.
 */
export function publishTipMovedRelativeToBaseline(input: {
	baselinePublishedCommit: string | null | undefined
	publishedCommit: string
}) {
	return (input.baselinePublishedCommit ?? null) !== input.publishedCommit
}

const outputSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('already_published'),
		unmappable_credentials_notice: z
			.string()
			.nullable()
			.optional()
			.describe(
				'Set when the package has unmappable credentials: explains that changes and publishes are owner-only unless a grant allows them, and how to allow one collaborator.',
			),
		published_commit: z.string().nullable(),
		artifacts_rebuilt: artifactsRebuiltSchema,
		checks_rerun: checksRerunSchema,
		message: alreadyPublishedMessageSchema,
		hosted_app_url: z.string().nullable(),
		test_hints: packageTestHintsSchema.optional(),
		static_dependents: staticDependentsSchema,
		pending_secret_package_approvals: pendingPackageSecretApprovalsSchema,
		allowed_packages_publish_notice: allowedPackagesPublishNoticeSchema,
		listing: communityListingBehindHintSchema.optional(),
		phase_timings: publishPhaseTimingsSchema,
		build_origin: publishBuildOriginSchema.optional(),
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
				'Full 40-character SHA-1 of the HEAD commit that passed checks. Promote it on the website approval page. Do not abbreviate it.',
			),
		approval_url: z
			.string()
			.describe(
				'Owner page for pending_commit. The commit query is that full 40-character SHA-1.',
			),
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
		run_id: z
			.string()
			.optional()
			.describe(
				'Deprecated and no longer returned: it was an internal check-attempt id that runGet cannot load. Use packageRunResult for a dispatched publish.',
			),
	}),
	z.object({
		status: z.literal('published'),
		unmappable_credentials_notice: z
			.string()
			.nullable()
			.optional()
			.describe(
				'Set when the package has unmappable credentials: explains that changes and publishes are owner-only unless a grant allows them, and how to allow one collaborator.',
			),
		previous_commit: z.string().nullable(),
		published_commit: z.string(),
		manifest: z.unknown(),
		checks: z.array(checkSchema),
		hosted_app_url: z.string().nullable(),
		test_hints: packageTestHintsSchema.optional(),
		static_dependents: staticDependentsSchema,
		pending_secret_package_approvals: pendingPackageSecretApprovalsSchema,
		allowed_packages_publish_notice: allowedPackagesPublishNoticeSchema,
		listing: communityListingBehindHintSchema.optional(),
		phase_timings: publishPhaseTimingsSchema,
		build_origin: publishBuildOriginSchema.optional(),
	}),
	z
		.object({
			status: z.literal('held_for_approval'),
			unmappable_credentials_notice: z.string().nullable().optional(),
			previous_commit: z
				.string()
				.nullable()
				.describe('The package tip before this publish request.'),
			...heldForApprovalStatusShape,
			hosted_app_url: z.string().nullable(),
			test_hints: packageTestHintsSchema.optional(),
			static_dependents: staticDependentsSchema,
			pending_secret_package_approvals: pendingPackageSecretApprovalsSchema,
			allowed_packages_publish_notice: allowedPackagesPublishNoticeSchema,
			listing: communityListingBehindHintSchema.optional(),
			phase_timings: publishPhaseTimingsSchema,
			build_origin: publishBuildOriginSchema.optional(),
		})
		.describe(heldForApprovalStatusDescription),
	z.object({
		status: z.literal('dispatched'),
		workflow_id: z.string(),
		workflow_name: z.string(),
		idempotency_key: z.string(),
		run_status: z.string().nullable(),
		message: z.string(),
		phase_timings: publishPhaseTimingsSchema,
		build_origin: publishBuildOriginSchema.optional(),
	}),
])

type PublishExternalPushResult = z.infer<typeof outputSchema>

/** Only builds made outside the cloud (publish-offload) say where they ran. */
function buildOriginField(
	uploadedBuild: UploadedPublishBuildRef | null | undefined,
) {
	if (!showBuildOrigin || !uploadedBuild) return {}
	return {
		build_origin: {
			origin: uploadedBuild.origin,
			context_name: uploadedBuild.contextName ?? null,
		},
	}
}

type PublishedResult = Extract<
	PublishExternalPushResult,
	{ status: 'published' }
>

/**
 * Fields every status whose commit was recorded (published,
 * already_published, held_for_approval) returns, so a new optional field
 * cannot land on only one path.
 */
function publishRecordedFields(input: {
	extras: {
		hosted_app_url: PublishedResult['hosted_app_url']
		testHints?: PublishedResult['test_hints'] | null
		static_dependents: PublishedResult['static_dependents']
		pending_secret_package_approvals: PublishedResult['pending_secret_package_approvals']
		allowed_packages_publish_notice: PublishedResult['allowed_packages_publish_notice']
		held: HeldForApprovalPublishStatus | null
		listing?: PublishedResult['listing'] | null
	}
	phaseTimings: PublishPhaseTimings
	uploadedBuild: UploadedPublishBuildRef | null | undefined
}) {
	const { extras } = input
	return {
		hosted_app_url: extras.hosted_app_url,
		...(extras.testHints ? { test_hints: extras.testHints } : {}),
		static_dependents: extras.static_dependents,
		pending_secret_package_approvals: extras.pending_secret_package_approvals,
		allowed_packages_publish_notice: extras.allowed_packages_publish_notice,
		...(extras.listing ? { listing: extras.listing } : {}),
		phase_timings: input.phaseTimings,
		...buildOriginField(input.uploadedBuild),
	}
}

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

/**
 * The publish renames the saved package to the published manifest name, so
 * links in the result read the row again instead of the pre-publish name.
 */
async function readPublishedPackageIdentity(input: {
	env: Env
	ownerUserId: OwnerId
	packageId: string
	kodyId: string
	name: string
}) {
	const saved = await getSavedPackageById(input.env.APP_DB, {
		userId: input.ownerUserId,
		packageId: input.packageId,
	})
	return saved
		? { kodyId: saved.kodyId, name: saved.name }
		: { kodyId: input.kodyId, name: input.name }
}

async function resolvePublishedHostedAppUrl(input: {
	env: Env
	baseUrl: string
	ownerScope: string
	ownerEmail: string
	/** Scoped package name. The hosted path uses its leaf, not a stale kody id. */
	name: string
	hasApp: boolean
}) {
	if (!input.hasApp) return null
	const username = await resolvePublicUsername({
		db: input.env.APP_DB,
		username: input.ownerScope,
		email: input.ownerEmail,
	})
	if (!username) return null
	const hostedKodyId = getPackageNameLeaf(input.name)
	const canonical = await resolvePublicPackageAppLocation({
		env: input.env,
		username,
		kodyId: hostedKodyId,
	})
	if (canonical) return canonical.hostedUrl
	return resolveHostedPackageAppUrl({
		packageAppBaseUrl: getPackageAppBaseUrl({ env: input.env }),
		appBaseUrl: input.baseUrl,
		username,
		kodyId: hostedKodyId,
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

async function getAllowedPackagesPublishNoticeForPublishedPackage(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	orgSlug?: string | null
	packageId: string
	packageDisplayName: string
	kodyId: string
	sourceId: string
}): Promise<string | null> {
	try {
		const published = await loadPublishedEntitySource({
			env: input.env,
			userId: input.userId,
			sourceId: input.sourceId,
		})
		// Published snapshots used here are package-relative (or already keyed
		// for packageSave). Do not pass sourceRoot — strict strip would empty
		// an already-scoped tree.
		return await buildCredentialAllowedPackagesPublishWarningNotice({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			orgSlug: input.orgSlug,
			packageId: input.packageId,
			packageDisplayName: input.packageDisplayName,
			kodyId: input.kodyId,
			files: published.files,
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
	publishBuildId?: string
}

export function buildExternalPublishIdempotencyParts(
	input: ExternalPublishSemanticInput,
) {
	// Caller identity is applied by dispatchDurableRun (RunLog workflow
	// projections are user-scoped). Distinct delegates may each dispatch for
	// the same publish; that is safe because re-invoking publish when
	// published_commit already matches HEAD is idempotent (no D1 tip write).
	// The capability remaps that RepoSession already_published to published
	// when the tip moved relative to the pre-request baseline so agents do
	// not treat a real tip advance as a no-op. Active and published durable
	// runs still dedupe on this key; a terminal failure (including a durable
	// run whose publish did not publish) releases it so the same commit can
	// publish again.
	// Older workflow runs could publish a different HEAD from the one they
	// were enqueued for. Only dedupe against runs with the commit check.
	return [
		'packagePublishExternalPush',
		'v3',
		canonicalJsonStringify(input),
	] as const
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
	packageDisplayName: string
	kodyId: string
	name: string
	hasApp: boolean
	source: {
		id: string
		repo_id: string
	}
	/**
	 * Tip before this publish request (and before any earlier attempt of the
	 * durable step that may have advanced D1). Durable re-entry must pass the
	 * dispatching request's baseline, not a fresh D1 read.
	 */
	baselinePublishedCommit: string | null
	newCommit: string
	allowForce: boolean
	destructiveOverwriteConfirmed: boolean
	requestedByUserId: string | null
	publisherRequest?: RequestContext | null
	approvalViewer: ApprovalViewer | null
	reportProgress?: McpReportProgress
	durableReentry?: boolean
	/** Publish offload: persist this verified upload instead of rebuilding. */
	uploadedBuild?: UploadedPublishBuildRef | null
}): Promise<Exclude<PublishExternalPushResult, { status: 'dispatched' }>> {
	const assertCurrent = (commit: string) =>
		assertPackagePublishCurrent({
			env: input.env,
			sourceId: input.source.id,
			userId: input.ownerUserId,
			commit,
		})
	const maxAttempts = externalPublishRetryDelaysMs.length + 1
	let lastTransientError: unknown = null
	let phase = ''
	const rebuildPhase = input.uploadedBuild
		? 'finalizing the uploaded build'
		: 'rebuilding published artifacts'
	for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
		phase = 'checking and recording the source commit'
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
				publisherRequest: input.publisherRequest ?? null,
				deferBundleCheckToRebuild: true,
				// The publish builder typechecked this exact tree (verified by hash).
				...(input.uploadedBuild
					? { uploadedBuildId: input.uploadedBuild.buildId }
					: {}),
			})
			const publishMs = Date.now() - publishStartedAt
			if (result.status === 'already_published') {
				const publishedCommit = result.published_commit
				if (!publishedCommit) {
					throw new Error(
						`Package "${input.packageId}" is already published, but no published commit is available to rebuild artifacts.`,
					)
				}
				// RepoSession tip==HEAD is idempotent, but an earlier attempt of
				// the durable step may have advanced the tip after this
				// request's baseline. Agents use already_published to skip
				// dependent republishes — only a true pre-request no-op qualifies.
				const tipMoved = publishTipMovedRelativeToBaseline({
					baselinePublishedCommit: input.baselinePublishedCommit,
					publishedCommit,
				})
				const forceRebuild = result.force_artifact_rebuild === true
				await reportCapabilityProgress(input.reportProgress, {
					progress: maxAttempts + 1,
					total: maxAttempts + 1,
					message: tipMoved
						? forceRebuild
							? `Published after ${publishMs}ms (tip advanced earlier in this request) — snapshot changed, rebuilding artifacts…`
							: `Published after ${publishMs}ms (tip advanced earlier in this request) — confirming artifacts match this commit…`
						: forceRebuild
							? `Already published after ${publishMs}ms — snapshot changed, rebuilding artifacts…`
							: `Already published after ${publishMs}ms — confirming artifacts match this commit…`,
				})
				phase = rebuildPhase
				const { durationMs: rebuildMs, value: rebuildOutcome } =
					await timePublishExternalPushPhase(
						{
							phase: 'rebuild',
							sourceId: input.source.id,
							publishedCommit,
						},
						async () => {
							try {
								const rebuild =
									await rebuildPublishedPackageArtifactsViaRepoSession({
										env: input.env,
										rpcSessionId: sessionId,
										sourceId: input.source.id,
										userId: input.ownerUserId,
										publishedCommit,
										baseUrl: input.baseUrl,
										...(forceRebuild ? { force: true } : {}),
										...(input.uploadedBuild
											? { uploadedBuild: input.uploadedBuild }
											: {}),
									})
								return {
									ok: true as const,
									rebuiltTargetCount: rebuild.rebuiltTargetCount,
								}
							} catch (error) {
								if (isExternalPublishResourceLimitError(error)) {
									// Terminal: settle like any failed rebuild so the pointer
									// and job pins stay on the last good commit.
									await settleFailedPublishRebuild({
										env: input.env,
										baseUrl: input.baseUrl,
										ownerUserId: input.ownerUserId,
										packageId: input.packageId,
										sourceId: input.source.id,
										failedCommit: publishedCommit,
										sentryScope: externalPushRestoreSentryScope,
									})
								}
								throwIfExternalPublishResourceLimit(
									error,
									'rebuild',
									input.uploadedBuild != null,
								)
								if (isTransientDurableObjectResetError(error)) {
									throw error
								}
								if (input.uploadedBuild && !isUserCodeError(error)) {
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
					phase = 'restoring the previous publish after a failed rebuild'
					await settleFailedPublishRebuild({
						env: input.env,
						baseUrl: input.baseUrl,
						ownerUserId: input.ownerUserId,
						packageId: input.packageId,
						sourceId: input.source.id,
						failedCommit: publishedCommit,
						sentryScope: externalPushRestoreSentryScope,
					})
					return {
						status: 'checks_failed' as const,
						failed_checks: [rebuildOutcome.failedCheck],
						manifest: null,
					}
				}
				const artifactsRebuilt =
					forceRebuild || rebuildOutcome.rebuiltTargetCount > 0
				phase = 'checking dependents and preparing publish details'
				const { durationMs: dependentsMs, value: alreadyPublishedExtras } =
					await timePublishExternalPushPhase(
						{
							phase: 'dependents',
							sourceId: input.source.id,
							publishedCommit,
						},
						async () => {
							const published = await readPublishedPackageIdentity(input)
							const [testHints, listing] = await Promise.all([
								getPublishedPackageTestHints({
									env: input.env,
									baseUrl: input.baseUrl,
									userId: input.ownerUserId,
									sourceId: input.source.id,
									packageId: input.packageId,
									kodyId: published.kodyId,
									publisherUserId: input.requestedByUserId ?? input.ownerUserId,
								}),
								getListingBehindPublishHint({
									env: input.env,
									baseUrl: input.baseUrl,
									ownerUserId: input.ownerUserId,
									ownerScope: input.ownerScope,
									packageId: input.packageId,
									kodyId: published.kodyId,
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
									name: published.name,
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
										kodyId: published.kodyId,
										sourceId: input.source.id,
									}),
								held: await loadHeldForApprovalPublishStatus({
									env: input.env,
									baseUrl: input.baseUrl,
									ownerUserId: input.ownerUserId,
									ownerScope: input.ownerScope,
									packageId: input.packageId,
									kodyId: published.kodyId,
								}),
								allowed_packages_publish_notice:
									await getAllowedPackagesPublishNoticeForPublishedPackage({
										env: input.env,
										baseUrl: input.baseUrl,
										userId: input.ownerUserId,
										orgSlug: input.orgSlug,
										packageId: input.packageId,
										packageDisplayName: published.name,
										kodyId: published.kodyId,
										sourceId: input.source.id,
									}),
							}
						},
					)
				const phaseTimings = buildPublishPhaseTimings({
					startedAt: publishStartedAt,
					fromPublish: result.phase_timings,
					rebuildMs,
					dependentsMs,
				})
				const sharedSuccessFields = {
					...publishRecordedFields({
						extras: alreadyPublishedExtras,
						phaseTimings,
						uploadedBuild: input.uploadedBuild,
					}),
				}
				await reportCapabilityProgress(input.reportProgress, {
					progress: maxAttempts + 1,
					total: maxAttempts + 1,
					message: `Confirming the published commit after artifact rebuild (${rebuildMs}ms) and dependent checks (${dependentsMs}ms).`,
				})
				phase = 'confirming the serving commit'
				await assertCurrent(publishedCommit)
				if (alreadyPublishedExtras.held) {
					return {
						status: 'held_for_approval' as const,
						previous_commit: input.baselinePublishedCommit ?? null,
						...alreadyPublishedExtras.held,
						...sharedSuccessFields,
					}
				}
				if (tipMoved) {
					return {
						status: 'published' as const,
						previous_commit: input.baselinePublishedCommit,
						published_commit: publishedCommit,
						manifest: null,
						checks: [],
						...sharedSuccessFields,
					}
				}
				const checksRerun = result.checks_rerun === true
				return {
					status: 'already_published' as const,
					published_commit: publishedCommit,
					artifacts_rebuilt: artifactsRebuilt,
					...(checksRerun
						? {
								checks_rerun: true,
								message:
									result.message ??
									'HEAD was already published; checks were re-run under the current checker and passed.',
							}
						: {}),
					...sharedSuccessFields,
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
						appendSecretMountCompatNotice(
							createPackagePublishLockedMessage({
								packageName: result.packageName,
								approvalUrl,
							}),
							result.secret_mount_compat,
						),
						result.allowed_packages_publish_notice,
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
						appendSecretMountCompatNotice(
							approvalMessage,
							result.secret_mount_compat,
						),
						result.allowed_packages_publish_notice,
					),
				}
			}
			if (result.status === 'checks_failed') {
				const { run_id: _checkAttemptId, ...checksFailed } = result
				return checksFailed
			}
			if (result.status !== 'published') {
				return result
			}
			await reportCapabilityProgress(input.reportProgress, {
				progress: maxAttempts + 1,
				total: maxAttempts + 1,
				message: `Checks passed in ${publishMs}ms — rebuilding published artifacts and indexing dependents…`,
			})
			phase = rebuildPhase
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
								...(input.uploadedBuild
									? { uploadedBuild: input.uploadedBuild }
									: {}),
							})
							return { ok: true as const }
						} catch (error) {
							if (isExternalPublishResourceLimitError(error)) {
								// Terminal: settle like any failed rebuild so the pointer and
								// job pins go back to the last good commit.
								await settleFailedPublishRebuild({
									env: input.env,
									baseUrl: input.baseUrl,
									ownerUserId: input.ownerUserId,
									packageId: input.packageId,
									sourceId: input.source.id,
									failedCommit: result.published_commit,
									sentryScope: externalPushRestoreSentryScope,
								})
							}
							throwIfExternalPublishResourceLimit(
								error,
								'rebuild',
								input.uploadedBuild != null,
							)
							if (isTransientDurableObjectResetError(error)) {
								throw error
							}
							if (input.uploadedBuild && !isUserCodeError(error)) {
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
				phase = 'restoring the previous publish after a failed rebuild'
				await settleFailedPublishRebuild({
					env: input.env,
					baseUrl: input.baseUrl,
					ownerUserId: input.ownerUserId,
					packageId: input.packageId,
					sourceId: input.source.id,
					failedCommit: result.published_commit,
					sentryScope: externalPushRestoreSentryScope,
				})
				return {
					status: 'checks_failed' as const,
					failed_checks: [rebuildOutcome.failedCheck],
					manifest: result.manifest ?? null,
				}
			}
			phase = 'checking dependents and preparing publish details'
			const { durationMs: dependentsMs, value: publishedExtras } =
				await timePublishExternalPushPhase(
					{
						phase: 'dependents',
						sourceId: input.source.id,
						publishedCommit: result.published_commit,
					},
					async () => {
						const published = await readPublishedPackageIdentity(input)
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
							kodyId: published.kodyId,
							enablementTriggers,
						})
						const listing = await getListingBehindPublishHint({
							env: input.env,
							baseUrl: input.baseUrl,
							ownerUserId: input.ownerUserId,
							ownerScope: input.ownerScope,
							packageId: input.packageId,
							kodyId: published.kodyId,
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
								name: published.name,
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
									kodyId: published.kodyId,
									sourceId: input.source.id,
								}),
							held: await loadHeldForApprovalPublishStatus({
								env: input.env,
								baseUrl: input.baseUrl,
								ownerUserId: input.ownerUserId,
								ownerScope: input.ownerScope,
								packageId: input.packageId,
								kodyId: published.kodyId,
							}),
							allowed_packages_publish_notice:
								result.allowed_packages_publish_notice ??
								(await getAllowedPackagesPublishNoticeForPublishedPackage({
									env: input.env,
									baseUrl: input.baseUrl,
									userId: input.ownerUserId,
									orgSlug: input.orgSlug,
									packageId: input.packageId,
									packageDisplayName: published.name,
									kodyId: published.kodyId,
									sourceId: input.source.id,
								})),
						}
					},
				)
			await reportCapabilityProgress(input.reportProgress, {
				progress: maxAttempts + 1,
				total: maxAttempts + 1,
				message: `Confirming the published commit after artifact rebuild (${rebuildMs}ms) and dependent checks (${dependentsMs}ms).`,
			})
			phase = 'confirming the serving commit'
			await assertCurrent(result.published_commit)
			const recordedFields = publishRecordedFields({
				extras: publishedExtras,
				phaseTimings: buildPublishPhaseTimings({
					startedAt: publishStartedAt,
					fromPublish: result.phase_timings,
					rebuildMs,
					dependentsMs,
				}),
				uploadedBuild: input.uploadedBuild,
			})
			if (publishedExtras.held) {
				return {
					status: 'held_for_approval' as const,
					previous_commit: result.previous_commit,
					...publishedExtras.held,
					...recordedFields,
				}
			}
			return { ...result, ...recordedFields } as const
		} catch (error) {
			try {
				if (
					!(error instanceof McpCallerError) &&
					isDurableObjectIsolateResourceLimitResetError(error)
				) {
					// The reset instance left its current step in storage.
					const step = await readLastCheckStep(
						repoSessionRpc(input.env, sessionId),
					)
					throwIfExternalPublishResourceLimit(
						error,
						step,
						input.uploadedBuild != null,
					)
				}
				throwIfExternalPublishResourceLimit(error)
			} catch (limitOrCallerError) {
				if (!input.durableReentry) throw limitOrCallerError
				throw failureDuringPublishPhase(limitOrCallerError, phase)
			}
			if (!isTransientDurableObjectResetError(error)) {
				if (input.durableReentry) {
					throw failureDuringPublishPhase(error, phase)
				}
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
				willRetry,
				error,
			})
			if (!willRetry) {
				break
			}
			await delay(nextDelayMs)
		}
	}
	throw new Error(
		`packagePublishExternalPush could not recover after ${maxAttempts} transient Durable Object reset attempts while ${phase}: ${getErrorMessage(
			lastTransientError,
		)}`,
	)
}

export const publishExternalPushCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packagePublishExternalPush',
		walletGuard: 'publish',
		contextRuns: 'deny',
		orgPermission: 'package:write',
		description:
			'Publish the current Artifacts git HEAD for a saved package after a packageGetGitRemote clone/edit/push workflow and server-side checks pass. Non-fast-forward publishes require explicit destructive overwrite confirmation and a verified restorable backup snapshot. Full check-time esbuild is deferred to the published artifact rebuild so callable and importable targets are bundled once; unchanged targets are copied from the previous published commit when their reachable inputs match, and a rebuild failure returns checks_failed with a bundle check. A publish whose commit is built but not live returns held_for_approval, never published or already_published: an internet-visible app asked for more capabilities than its approved version, so everyone stays on serving_commit until the owner approves held_commit at approval_url (ADR 0069). That is different from locked and approval_required, which pause a publish before it starts. Published, already_published, and held_for_approval responses include hosted_app_url when the package declares an app, plus bounded static dependent metadata so agents can decide whether stale kody:@ bundled snapshots need inspection or dependent republish; Kody does not republish dependents automatically. already_published means the package tip already matched HEAD before this request began; a true no-op (same checker version, prior success) skips checks, while a missing or older stored checker version re-runs checks, refreshes the stamp, and sets checks_rerun true with a message. It still runs the artifact rebuild and sets artifacts_rebuilt true when any target needed rebuild or a forced snapshot repair ran. If published_commit moved relative to that pre-request tip — including a durable step retry after an earlier attempt advanced the tip — the status is published with previous_commit set to the baseline tip, even when RepoSession reported tip==HEAD. Those success results also include phase_timings with optional millisecond fields clone_ms, checks_typecheck_ms, checks_bundle_ms, rebuild_ms, dependents_ms, and total_ms — omitted keys did not run; checks_bundle_ms is omitted when bundle validation is deferred to rebuild; checks_bundle_ms and rebuild_ms stay separate. The publish always runs as a durable workflow, never in the calling request: this capability returns status dispatched with a workflow_id right away (idempotent per acting caller plus the full semantic publish input, including force/overwrite flags). Poll packageRunResult({ workflow_id }) until its `status` is terminal; the same answer then carries the full publish result. Active and published durable runs still dedupe. A durable run whose publish did not go live (checks_failed, not_fast_forward, locked, approval_required, held_for_approval) ends errored with the reason in packageRunResult `last_error`, and like any terminal failure (for example a Durable Object reset because its code was updated) retrying the same commit starts a fresh run with a new workflow_id. dispatched includes phase_timings.total_ms as time-to-dispatch.',
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
			const nameInput = args.name?.trim() || undefined
			const leftoverKodyIdInput = args.kody_id?.trim() || undefined
			if (nameInput !== undefined && leftoverKodyIdInput !== undefined) {
				throw new McpCallerError(
					'Provide `name` or leftover `kody_id`, not both. Prefer `name`.',
				)
			}
			const { packageId, userId, kodyId, hasApp, name, source } =
				await resolveOwnedPackageSource({
					db: ctx.env.APP_DB,
					userId: owner.ownerUserId,
					ownerScope: owner.ownerScope,
					args: {
						package_id: args.package_id,
						kody_id: nameInput ?? leftoverKodyIdInput,
					},
				})
			await authorizePackageWrite(
				{ env: ctx.env, request: ctx.callerContext.request },
				{ id: packageId, userId, label: name },
			)
			const unmappable = knownUnmappableCredentials(
				await loadOnePackageUnmappableCredentials({
					env: ctx.env,
					orgId: userId,
					packageId,
					request: ctx.callerContext.request,
				}),
			)
			const unmappableNotice =
				unmappable.length > 0
					? unmappableCredentialOwnerNotice({
							packageLabel: `Package "${name}"`,
							credentials: unmappable,
						})
					: null
			const withUnmappableNotice = <T extends PublishExternalPushResult>(
				result: T,
			): T =>
				unmappableNotice &&
				(result.status === 'published' ||
					result.status === 'already_published' ||
					result.status === 'held_for_approval')
					? { ...result, unmappable_credentials_notice: unmappableNotice }
					: result
			const head = await resolveArtifactSourceHead(ctx.env, source.repo_id)
			const newCommit = head.commit
			if (!newCommit) {
				throw new Error(
					`Artifacts repo "${source.repo_id}" has no published HEAD to reconcile.`,
				)
			}

			// Prefer the dispatching request's baseline stamped into durableParams,
			// but only on durable (background) re-entry. Interactive callers
			// often send null for unused optionals; trusting that would turn a
			// true no-op tip into published with previous_commit: null.
			// Re-reading D1 on durable re-entry would see a tip an earlier
			// attempt of the step already advanced and wrongly yield
			// already_published.
			const baselinePublishedCommit =
				ctx.callerContext.executionOrigin === 'background' &&
				args.baseline_published_commit !== undefined
					? args.baseline_published_commit
					: (source.published_commit ?? null)

			// Durable re-entry already routed (its build id rides in durableParams).
			const durableReentry =
				ctx.callerContext.executionOrigin === 'background' &&
				args.baseline_published_commit !== undefined
			if (
				durableReentry &&
				args.expected_head &&
				args.expected_head !== newCommit
			) {
				throw new McpCallerError(
					buildArtifactsHeadChangedBeforePublishMessage(
						args.expected_head,
						newCommit,
					),
				)
			}
			const route =
				args.publish_build_id || durableReentry
					? null
					: await decidePublishRoute({
							requestedContext: args.context,
							packageRef: name,
							deps: publishRouteDeps({
								env: ctx.env,
								callerContext: ctx.callerContext,
								request: requireMcpRequest(ctx.callerContext),
								personId: user.userId,
								packageId,
								packageName: name,
								ownerUserId: userId,
								source,
								commit: newCommit,
							}),
						})
			const publishBuildId =
				args.publish_build_id ??
				(route?.kind === 'context' ? route.buildId : undefined)

			const publishInput = {
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				ownerUserId: owner.ownerUserId,
				ownerScope: owner.ownerScope,
				orgSlug: secretPageOrgSlugFromCaller(ctx.callerContext),
				ownerEmail: owner.ownerEmail,
				expectedPackageScope,
				packageId,
				packageDisplayName: name,
				kodyId,
				name,
				hasApp,
				source: { id: source.id, repo_id: source.repo_id },
				baselinePublishedCommit,
				newCommit,
				allowForce: args.allow_force,
				destructiveOverwriteConfirmed: args.confirm_destructive_overwrite,
				requestedByUserId: user.userId,
				publisherRequest: ctx.callerContext.request ?? null,
				approvalViewer: optionalApprovalViewerForCaller(ctx),
				reportProgress: ctx.reportProgress,
				durableReentry,
				uploadedBuild: publishBuildId
					? await resolveUploadedPublishBuildForPublish({
							db: ctx.env.APP_DB,
							buildId: publishBuildId,
							packageId,
							sourceId: source.id,
							commit: newCommit,
							requesterUserId: publishRequesterPersonId(ctx.callerContext),
							orgId: requireMcpRequest(ctx.callerContext).org.id,
						}).catch((error: unknown) => {
							if (!durableReentry) throw error
							throw failureDuringPublishPhase(
								error,
								'validating the uploaded build',
							)
						})
					: null,
			}

			// The durable run is the only place a publish executes: its step
			// re-enters this capability with the baseline stamped at dispatch.
			if (durableReentry) {
				return withUnmappableNotice(
					await runExternalPublishAttempt(publishInput),
				)
			}

			const semanticInput = {
				ownerUserId: owner.ownerUserId,
				packageId,
				newCommit,
				allowForce: args.allow_force,
				destructiveOverwriteConfirmed: args.confirm_destructive_overwrite,
				...(publishBuildId ? { publishBuildId } : {}),
			} satisfies ExternalPublishSemanticInput
			const durableParams = {
				...(args.package_id ? { package_id: args.package_id } : {}),
				...(nameInput
					? { name: nameInput }
					: leftoverKodyIdInput
						? { kody_id: leftoverKodyIdInput }
						: {}),
				allow_force: args.allow_force,
				confirm_destructive_overwrite: args.confirm_destructive_overwrite,
				baseline_published_commit: baselinePublishedCommit,
				...(publishBuildId ? { publish_build_id: publishBuildId } : {}),
			}
			const dispatchStartedAt = Date.now()
			// Key the durable re-entry to the package-owning org, not the actor's
			// personal org. Team publishes (`@kody`, …) otherwise re-bind to the
			// actor personal org and fail mid-rebuild after git accepted the push.
			const outcome = await dispatchDurableRun({
				env: ctx.env,
				userId: owner.ownerUserId,
				userEmail: packageOwnerEntitlementEmail(owner),
				lineage: requestLineage(requireMcpRequest(ctx.callerContext)),
				idempotencyParts: buildExternalPublishIdempotencyParts(semanticInput),
				workflowName: 'packagePublishExternalPush',
				packageContext: {
					packageId,
					kodyId,
					sourceId: source.id,
				},
				enqueuedCommit: newCommit,
				durableCode: durablePublishWorkflowCode,
				durableParams,
				// Publishing a commit again is how its artifacts are repaired,
				// and a finished run's stored result expires: run it again.
				rerunComplete: true,
			})

			switch (outcome.kind) {
				case 'dispatched':
					// The durable run finishes as the owning org, which is not a
					// person. Note who asked, so the finish step can record them
					// as publisher once this commit is published.
					await notePackageAppPublishRequester({
						db: ctx.env.APP_DB,
						scope: { orgId: owner.ownerUserId, packageId },
						personId: user.userId,
						commit: newCommit,
					})
					return {
						...outcome.handle,
						phase_timings: withPublishAttemptTotalMs({}, dispatchStartedAt),
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
