import { normalizePackageInvocationExportName } from '@kody-internal/shared/public-urls.ts'
import { type PackageEventTools } from '#mcp/run-kody-registry.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type createMcpCallerContext } from '#mcp/context.ts'
import { type RequestSource } from '#worker/request-context/request-context.ts'
import {
	type RunRecordContext,
	type RunSurface,
} from '#worker/run-records/types.ts'
import {
	packageWorkflowInvocationSource,
	sealedSecretProviderInvocationSource,
} from '#worker/package-runtime/package-invocation-sources.ts'
import { type listPackageSubscriptions } from '#worker/package-registry/manifest.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { type PackageInvocationStoredResponse } from './repo.ts'

export type PackageInvocationTokenScope = {
	tokenId: string
	userId: string
	email?: string
	packageId: string
	exportNames?: Array<string>
	request: RequestSource
}

export type PackageInvocationRequest = {
	packageIdOrKodyId: string
	exportName: string
	params?: Record<string, unknown>
	/**
	 * `null` selects the key-less (lean/ephemeral) path for runtime callers:
	 * no idempotency ledger row, no account write lease, run records on
	 * failure only. External webhook invocations still require a key.
	 */
	idempotencyKey: string | null
	/**
	 * `'ignore'` matches the ledger by key alone and returns the retained
	 * response as stored (no `idempotency.replayed` marker). Used only by
	 * delivery-id webhook replays: retries change `receivedAt` (and often
	 * headers), and the same delivery id is the same event even when the
	 * body bytes differ. The key already binds
	 * `userId + packageId + webhookName + deliveryId`, so a different
	 * delivery cannot reuse another event's acknowledgement.
	 */
	idempotencyParamsHash?: 'ignore'
	/**
	 * When set, the ledger hashes this object instead of `params`. Webhook
	 * request-mode caller keys use it so `receivedAt` (and other volatile
	 * envelope fields) do not turn a retry into `idempotency_mismatch`.
	 */
	idempotencyHashParams?: Record<string, unknown>
	/**
	 * Delivery/attempt lineage for the idempotency claim (webhook ack
	 * `deliveryId`). Same-owner queue retries reclaim a dead attempt's
	 * fresh `in_progress` row; omit when only stale-window reclaim applies.
	 */
	claimOwner?: string | null
	source?: string | null
	topic?: string | null
}

export type PackageInvocationResponse = PackageInvocationStoredResponse

export type PackageInvocationActor = {
	/**
	 * Frozen synthetic id (`internal:webhook:<id>`, `internal:package-events:…`).
	 * Keys the idempotency ledger and the automation entitlement skip.
	 */
	sourceId: string
	/** The org that owns the invoked package. */
	orgId: OwnerId
	/** How the run is attributed and authenticated. */
	request: RequestSource
}

export type PackageModuleSelector =
	| {
			kind: 'export'
			exportName: string
	  }
	| {
			kind: 'subscription'
			topic: string
	  }

export type PackageModuleResolution = {
	artifactName: string
	entryPoint: string
}

export type PackageRuntimeContext = {
	packageId: string
	kodyId: string
	sourceId?: string | null
}

export type LoadedPackageEventSubscription = {
	savedPackage: SavedPackageRecord
	subscription: ReturnType<typeof listPackageSubscriptions>[number]
}

export type PackageRuntimeToolFactoryInput = {
	env: Env
	baseUrl: string
	callerContext: ReturnType<typeof createMcpCallerContext>
	packageContext: PackageRuntimeContext | null
	parentRunRecord?: RunRecordContext | null
	packageInvokeDepth?: number
	/** Coarse telemetry attribution for package-app bridge calls. */
	runtimeSurface?: 'app'
	/**
	 * When set, nested package/export/subscription run-record finishes are
	 * scheduled on this callback instead of being awaited.
	 */
	waitUntil?: (promise: Promise<unknown>) => void
}

export function waitUntilFromExecutionContext(ctx?: ExecutionContext) {
	return ctx ? (promise: Promise<unknown>) => ctx.waitUntil(promise) : undefined
}

export type PackageRuntimeToolFactories = {
	createPackageEventTools(
		input: PackageRuntimeToolFactoryInput,
	): PackageEventTools
}

export const internalEmailSubscriptionTokenId = 'internal:email-subscriptions'
export {
	internalSyntheticSubscriptionTokenId,
	syntheticPackageSubscriptionSource,
} from './subscription-envelope.ts'
export const internalPackageEventSubscriptionTokenId = 'internal:package-events'
export const maxPackageRuntimeInvokeDepth = 8

/**
 * Error code for an invoke that refused to run because the package's published
 * revision no longer matches the revision the caller pinned (a pinned package
 * workflow whose package was republished after it was queued).
 */
export const sourceRevisionChangedErrorCode = 'source_revision_changed'

/**
 * Source-revision hooks for callers that own the run record (package
 * workflows). `onResolved` receives the immutable commit of the artifact about
 * to run, before any sandbox work. When `pinnedCommit` is set and the artifact
 * is at a different commit, the invoke is refused with
 * {@link sourceRevisionChangedErrorCode} and nothing runs.
 */
export type PackageSourceRevisionOptions = {
	pinnedCommit?: string | null
	onResolved?: (publishedCommit: string | null) => void
}
export const packageInvocationScopeWildcard = '*'

const npmScopedPackageNamePattern = /^@[^/\s]+\/[^/\s]+$/

export function normalizeExportName(exportName: string) {
	return normalizePackageInvocationExportName(exportName)
}

export function normalizeNullableString(value: string | null | undefined) {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

export function buildSavedPackageNotFoundMessage(packageIdOrKodyId: string) {
	const message = `Saved package ${JSON.stringify(packageIdOrKodyId)} was not found for this user.`
	if (!npmScopedPackageNamePattern.test(packageIdOrKodyId)) return message
	return `${message} Dynamic package invocation uses the bare kodyId (for example, "github"), not the npm-scoped package name (for example, "@acme/github").`
}

export function buildPackageInvocationStorageId(packageId: string) {
	// Shared with packageStorage() so all surfaces name the same bucket. Since
	// the ambient `storage` binding was removed from invocation runs, this only
	// feeds `callerContext.storageContext` (secret scoping and runtime-debug
	// metadata) — package code reaches the bucket via `packageStorage()`.
	return buildPackageStorageId(packageId)
}

export function createRepoContext(source: EntitySourceRow) {
	return {
		sourceId: source.id,
		repoId: source.repo_id,
		sessionId: null,
		baseCommit: source.published_commit,
		manifestPath: source.manifest_path,
		sourceRoot: source.source_root,
		publishedCommit: source.published_commit,
		entityKind: source.entity_kind,
		entityId: source.entity_id,
	}
}

/**
 * `null` means the caller already owns the run record. Package-backed workflows
 * record in `package-workflows.ts` (with `workflowId` + pre-invocation errors),
 * so the inner invoke must not open a second row.
 */
export function resolveInvocationRuntimeSurface(input: {
	selector: PackageModuleSelector
	source: string | null
}): RunSurface | null {
	if (
		input.source === packageWorkflowInvocationSource ||
		input.source === sealedSecretProviderInvocationSource
	) {
		return null
	}
	switch (input.selector.kind) {
		case 'export':
			return 'export'
		case 'subscription':
			return 'subscription'
		default: {
			const selector: never = input.selector
			void selector
			throw new Error('Unhandled package module selector.')
		}
	}
}

/**
 * Surface for UWD / execute-usage when the invocation itself does not own
 * a run record. Package-workflow exports suppress the runtime surface so
 * the workflow row is the only record; they still mint a Dynamic Worker
 * and must tag that day as `workflow`.
 */
export function resolveInvocationMeteringSurface(input: {
	selector: PackageModuleSelector
	source: string | null
}): RunSurface | null {
	return (
		resolveInvocationRuntimeSurface(input) ??
		(input.source === packageWorkflowInvocationSource
			? 'workflow'
			: input.source === sealedSecretProviderInvocationSource
				? 'export'
				: null)
	)
}

export function resolveInvocationRuntimeName(input: {
	surface: RunSurface
	invocationName: string
	topic: string | null
}) {
	switch (input.surface) {
		case 'workflow':
		case 'subscription':
			return input.topic ?? input.invocationName
		case 'export':
		case 'execute':
		case 'app_fetch':
		case 'app_realtime':
		case 'job':
		case 'retriever':
		case 'webhook':
			return input.invocationName
		default: {
			const surface: never = input.surface
			void surface
			throw new Error('Unhandled package runtime surface.')
		}
	}
}
