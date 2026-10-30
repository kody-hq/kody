import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { listOwnerIdsPendingDeletion } from '#worker/account/owner-deletion-state.ts'
import {
	credentialNeedEnforcementScope,
	selectCredentialNeedEnforcementScope,
} from '#worker/credentials/credential-need-enforcement-scope.ts'
import {
	listSavedPackagesByUserId,
	listSavedPackagesPage,
} from '#worker/package-registry/repo.ts'
import { isSavedPackageLocked } from '#worker/package-registry/package-publish-lock.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { getPackageScopeByUserId } from '#worker/package-registry/user-scope.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import {
	createSnapshotFilesWorkspace,
	runRepoChecks,
	type RepoCheckRunResult,
} from '#worker/repo/checks.ts'
import {
	syncArtifactSourceSnapshot,
	syncPublishedSourceSnapshotOnly,
} from '#worker/repo/source-sync.ts'
import {
	createPackageCodemodRun,
	getPackageCodemodRunById,
	insertPackageCodemodRunItem,
	listPackageCodemodRunItems,
	updatePackageCodemodRunItem,
	updatePackageCodemodRunFilters,
	updatePackageCodemodRunStatus,
	type PackageCodemodRunRecord,
	hasPackageCodemodRunItemForPackage,
} from './ledger.ts'
import { getPackageCodemodById } from './registry.ts'
import {
	createPackageCodemodSubscriptionCache,
	dispatchPackageCodemodSubscriptionEvent,
	packageCodemodAppliedTopic,
	packageCodemodRevertedTopic,
} from './subscription-events.ts'
import { computePackageAppCapabilityHostFacts } from './package-app-capability-closure.ts'
import { isRepoCheckResourceLimitMessage } from '#worker/repo/isolated-runner-limit-message.ts'
import {
	type PackageCodemod,
	type PackageCodemodApplyMode,
	type PackageCodemodContext,
	type PackageCodemodFinding,
} from './types.ts'

export type PackageCodemodRunMode = 'scan' | 'dry-run' | 'apply' | 'revert'

export type PackageCodemodRunScope =
	| { kind: 'user'; userId: OwnerId }
	| { kind: 'fleet' }

export type PackageCodemodRunFilters = {
	userIds?: Array<string>
	packageIds?: Array<string>
	/**
	 * Saved package ids that scan, dry-run, and apply record as needs_manual
	 * with a fixed finding instead of processing.
	 */
	excludePackageIds?: Array<string>
	/**
	 * Keep the run to packages the credential-need enforcement can reach.
	 * Reverts ignore it: they only touch items an earlier run applied.
	 */
	scope?: typeof credentialNeedEnforcementScope
}

export type PackageCodemodItemStatus =
	| 'detected'
	| 'clean'
	| 'dry_run_ok'
	| 'dry_run_new_failures'
	| 'needs_manual'
	| 'skipped_drift'
	| 'skipped_unpublished'
	| 'applied'
	| 'reverted'
	| 'failed'

export type PackageCodemodRunItemResult = {
	itemId: string
	userId: OwnerId
	packageId: string
	kodyId: string
	status: PackageCodemodItemStatus
	changedPaths: Array<string>
	findings: Array<PackageCodemodFinding>
	beforeCommit: string | null
	afterCommit: string | null
	checkSummary: { ok: boolean; newFailures: Array<string> } | null
	error: string | null
}

export type PackageCodemodRunStepResult = {
	runId: string
	codemodId: string
	mode: PackageCodemodRunMode
	items: Array<PackageCodemodRunItemResult>
	nextCursor: string | null
	summary: Partial<Record<PackageCodemodItemStatus, number>>
}

type PersistedItemResult = PackageCodemodRunItemResult & {
	revertSnapshotKey?: string | null
	/** Owner-private detail; persisted, never returned in step results. */
	ownerDetail?: Record<string, unknown> | null
}

const scanDefaultStepLimit = 20
const scanMaxStepLimit = 50
const heavyDefaultStepLimit = 5
const heavyMaxStepLimit = 10
const fleetScanPageSize = 50
const maxFleetPagesPerStep = 5
const revertSnapshotTtlSeconds = 90 * 24 * 60 * 60

type CodemodRevertSnapshot = {
	codemodId: string
	userId: OwnerId
	packageId: string
	beforeCommit: string | null
	files: Record<string, string>
}

export function buildPackageCodemodRevertSnapshotKvKey(input: {
	userId: OwnerId
	itemId: string
}) {
	return `package-codemod-revert:${input.userId}:${input.itemId}`
}

function compareBinaryIds(left: string, right: string) {
	if (left < right) return -1
	if (left > right) return 1
	return 0
}

function resolveStepLimit(mode: PackageCodemodRunMode, limit?: number) {
	if (mode === 'scan') {
		return Math.min(
			Math.max(limit ?? scanDefaultStepLimit, 1),
			scanMaxStepLimit,
		)
	}
	return Math.min(
		Math.max(limit ?? heavyDefaultStepLimit, 1),
		heavyMaxStepLimit,
	)
}

function normalizeFailureMessage(message: string) {
	return message.replace(/\d+/g, '#')
}

function failureKeys(result: RepoCheckRunResult): Set<string> {
	const keys = new Set<string>()
	for (const check of result.results) {
		if (check.ok) continue
		for (const line of failureLines(check.message)) {
			keys.add(`${check.kind}:${normalizeFailureMessage(line)}`)
		}
	}
	return keys
}

/**
 * Chunked checks join one line per failed chunk, so compare failures line by
 * line and drop lines that only say a chunk hit the runner limit.
 */
function failureLines(message: string) {
	const lines = message
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !isRepoCheckResourceLimitMessage(line))
	if (lines.length > 0 || isRepoCheckResourceLimitMessage(message)) return lines
	return [message]
}

/**
 * A check runner that hit its memory or CPU limit says nothing about the
 * change, so the comparison is inconclusive rather than a new failure.
 */
function hitCheckRunnerLimit(result: RepoCheckRunResult) {
	return result.results.some(
		(check) => !check.ok && isRepoCheckResourceLimitMessage(check.message),
	)
}

function computeCheckSummary(input: {
	before: RepoCheckRunResult
	after: RepoCheckRunResult
}) {
	const beforeFailures = failureKeys(input.before)
	const newFailures: Array<string> = []
	for (const key of failureKeys(input.after)) {
		if (!beforeFailures.has(key)) {
			newFailures.push(key)
		}
	}
	newFailures.sort((left, right) => left.localeCompare(right))
	return {
		ok: newFailures.length === 0,
		newFailures,
	}
}

function matchesCodemodTargetFilters(
	target: { userId: OwnerId; packageId: string },
	filters: PackageCodemodRunFilters | undefined,
) {
	if (!filters) return true
	if (
		filters.userIds != null &&
		filters.userIds.length > 0 &&
		!filters.userIds.includes(target.userId)
	) {
		return false
	}
	if (
		filters.packageIds != null &&
		filters.packageIds.length > 0 &&
		!filters.packageIds.includes(target.packageId)
	) {
		return false
	}
	return true
}

function matchesFilters(
	savedPackage: SavedPackageRecord,
	filters: PackageCodemodRunFilters | undefined,
) {
	return matchesCodemodTargetFilters(
		{ userId: savedPackage.userId, packageId: savedPackage.id },
		filters,
	)
}

function emptyItemResult(input: {
	itemId: string
	userId: OwnerId
	packageId: string
	kodyId: string
	status: PackageCodemodItemStatus
	error?: string | null
	findings?: Array<PackageCodemodFinding>
	changedPaths?: Array<string>
	beforeCommit?: string | null
	afterCommit?: string | null
	checkSummary?: PackageCodemodRunItemResult['checkSummary']
	revertSnapshotKey?: string | null
	ownerDetail?: Record<string, unknown> | null
}): PersistedItemResult {
	return {
		itemId: input.itemId,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
		status: input.status,
		changedPaths: input.changedPaths ?? [],
		findings: input.findings ?? [],
		beforeCommit: input.beforeCommit ?? null,
		afterCommit: input.afterCommit ?? null,
		checkSummary: input.checkSummary ?? null,
		error: input.error ?? null,
		revertSnapshotKey: input.revertSnapshotKey ?? null,
		ownerDetail: input.ownerDetail ?? null,
	}
}

function toPublicItem(item: PersistedItemResult): PackageCodemodRunItemResult {
	return {
		itemId: item.itemId,
		userId: item.userId,
		packageId: item.packageId,
		kodyId: item.kodyId,
		status: item.status,
		changedPaths: item.changedPaths,
		findings: item.findings,
		beforeCommit: item.beforeCommit,
		afterCommit: item.afterCommit,
		checkSummary: item.checkSummary,
		error: item.error,
	}
}

function incrementSummary(
	summary: Partial<Record<PackageCodemodItemStatus, number>>,
	status: PackageCodemodItemStatus,
) {
	summary[status] = (summary[status] ?? 0) + 1
}

function requestedScopeUserId(scope: PackageCodemodRunScope) {
	switch (scope.kind) {
		case 'user':
			return scope.userId
		case 'fleet':
			return null
		default: {
			const exhaustive: never = scope
			throw new Error(`Unknown package codemod scope: ${String(exhaustive)}`)
		}
	}
}

function normalizeFiltersJson(filters?: PackageCodemodRunFilters | null) {
	const userIds = [...(filters?.userIds ?? [])].sort((left, right) =>
		compareBinaryIds(left, right),
	)
	const packageIds = [...(filters?.packageIds ?? [])].sort((left, right) =>
		compareBinaryIds(left, right),
	)
	const normalized: PackageCodemodRunFilters = {}
	if (userIds.length > 0) normalized.userIds = userIds
	if (packageIds.length > 0) normalized.packageIds = packageIds
	const excludePackageIds = [...(filters?.excludePackageIds ?? [])].sort(
		(left, right) => compareBinaryIds(left, right),
	)
	if (excludePackageIds.length > 0) {
		normalized.excludePackageIds = excludePackageIds
	}
	if (filters?.scope) normalized.scope = filters.scope
	return JSON.stringify(normalized)
}

function parseStoredFiltersJson(filtersJson: string): PackageCodemodRunFilters {
	try {
		const parsed: unknown = JSON.parse(filtersJson)
		if (!parsed || typeof parsed !== 'object') return {}
		const record = parsed as Record<string, unknown>
		const filters: PackageCodemodRunFilters = {}
		if (Array.isArray(record.userIds)) {
			filters.userIds = record.userIds.filter(
				(value): value is string => typeof value === 'string',
			)
		}
		if (Array.isArray(record.packageIds)) {
			filters.packageIds = record.packageIds.filter(
				(value): value is string => typeof value === 'string',
			)
		}
		if (Array.isArray(record.excludePackageIds)) {
			filters.excludePackageIds = record.excludePackageIds.filter(
				(value): value is string => typeof value === 'string',
			)
		}
		if (record.scope === credentialNeedEnforcementScope) {
			filters.scope = credentialNeedEnforcementScope
		}
		return filters
	} catch {
		return {}
	}
}

/**
 * True when `requested` keeps every stored filter and only adds package ids
 * to `excludePackageIds`.
 */
function widensExclusionsOnly(
	stored: PackageCodemodRunFilters,
	requested: PackageCodemodRunFilters,
) {
	const withoutExclusions = (filters: PackageCodemodRunFilters) =>
		normalizeFiltersJson({ ...filters, excludePackageIds: [] })
	if (withoutExclusions(stored) !== withoutExclusions(requested)) return false
	const requestedExclusions = new Set(requested.excludePackageIds ?? [])
	return (stored.excludePackageIds ?? []).every((id) =>
		requestedExclusions.has(id),
	)
}

/**
 * Accepts requested continuation filters that equal the stored ones or only
 * widen `excludePackageIds`, persisting a widening with a compare-and-swap so
 * concurrent continuations can't drop each other's exclusions.
 */
async function reconcileRunFilters(
	db: D1Database,
	input: {
		run: PackageCodemodRunRecord
		requested: PackageCodemodRunFilters
		requestedJson: string
	},
): Promise<PackageCodemodRunRecord> {
	let current = input.run
	for (let attempt = 0; attempt < 3; attempt++) {
		const stored = parseStoredFiltersJson(current.filtersJson)
		if (normalizeFiltersJson(stored) === input.requestedJson) return current
		if (!widensExclusionsOnly(stored, input.requested)) {
			throw new Error(
				`Package codemod run "${current.id}" filters do not match the requested filters.`,
			)
		}
		const changed = await updatePackageCodemodRunFilters(db, {
			id: current.id,
			expectedFiltersJson: current.filtersJson,
			filtersJson: input.requestedJson,
		})
		if (changed > 0) return { ...current, filtersJson: input.requestedJson }
		const reloaded = await getPackageCodemodRunById(db, current.id)
		if (!reloaded) {
			throw new Error(`Package codemod run "${current.id}" was not found.`)
		}
		current = reloaded
	}
	throw new Error(
		`Package codemod run "${input.run.id}" filters kept changing concurrently; retry the step.`,
	)
}

async function ensureRun(input: {
	env: Env
	runId?: string
	codemodId: string
	mode: PackageCodemodRunMode
	scope: PackageCodemodRunScope
	initiatedByUserId: string
	filters?: PackageCodemodRunFilters
	revertOfRunId?: string
}): Promise<PackageCodemodRunRecord> {
	const scopeUserId = requestedScopeUserId(input.scope)
	const filtersJson = normalizeFiltersJson(input.filters)
	if (input.runId) {
		const existing = await getPackageCodemodRunById(
			input.env.APP_DB,
			input.runId,
		)
		if (!existing) {
			throw new Error(`Package codemod run "${input.runId}" was not found.`)
		}
		if (existing.codemodId !== input.codemodId) {
			throw new Error(
				`Package codemod run "${input.runId}" belongs to codemod "${existing.codemodId}", not "${input.codemodId}".`,
			)
		}
		if (existing.mode !== input.mode) {
			throw new Error(
				`Package codemod run "${input.runId}" is mode "${existing.mode}", not "${input.mode}".`,
			)
		}
		if (existing.scopeUserId !== scopeUserId) {
			throw new Error(
				`Package codemod run "${input.runId}" scope does not match the requested scope.`,
			)
		}
		// Continuation steps may omit revertOfRunId; the stored run is the
		// source of truth. Only an explicit mismatched value is rejected.
		if (
			input.revertOfRunId != null &&
			(existing.revertOfRunId ?? null) !== input.revertOfRunId
		) {
			throw new Error(
				`Package codemod run "${input.runId}" revertOfRunId does not match the requested value.`,
			)
		}
		// Continuation steps may omit filters; the stored run is the source of
		// truth. Only an explicit mismatched value is rejected, except that an
		// operator may widen `excludePackageIds` to step past a package that
		// keeps failing mid-run (apply has no unfinished-attempt skip).
		const run =
			input.filters === undefined
				? existing
				: await reconcileRunFilters(input.env.APP_DB, {
						run: existing,
						requested: input.filters,
						requestedJson: filtersJson,
					})
		if (existing.status !== 'completed') {
			// Heartbeat: every continuation step re-asserts `running` and bumps
			// `updated_at`, so stale-run reconciliation only marks runs nobody is
			// paging. This also reopens runs previously marked failed or
			// abandoned when a caller resumes them.
			await updatePackageCodemodRunStatus(input.env.APP_DB, {
				id: existing.id,
				status: 'running',
			})
			return { ...run, status: 'running' }
		}
		return run
	}
	return await createPackageCodemodRun(input.env.APP_DB, {
		id: crypto.randomUUID(),
		codemodId: input.codemodId,
		mode: input.mode,
		scopeUserId,
		initiatedByUserId: input.initiatedByUserId,
		filtersJson,
		status: 'running',
		revertOfRunId: input.revertOfRunId ?? null,
	})
}

async function applyScopeFilter(
	env: Env,
	packages: Array<SavedPackageRecord>,
	filters: PackageCodemodRunFilters | undefined,
) {
	if (filters?.scope !== credentialNeedEnforcementScope) return packages
	return await selectCredentialNeedEnforcementScope(env.APP_DB, packages)
}

/**
 * Drop packages whose owner is mid-deletion or deleted. Account deletion or
 * the purge lane owns their storage, so running a codemod there only records
 * noise failures (and could write to storage that is being removed).
 */
async function dropOwnersPendingDeletion(
	env: Env,
	packages: Array<SavedPackageRecord>,
) {
	if (packages.length === 0) return packages
	const pending = await listOwnerIdsPendingDeletion(
		env.APP_DB,
		packages.map((savedPackage) => savedPackage.userId),
	)
	if (pending.size === 0) return packages
	return packages.filter((savedPackage) => !pending.has(savedPackage.userId))
}

async function listCandidatePackages(input: {
	env: Env
	scope: PackageCodemodRunScope
	filters?: PackageCodemodRunFilters
	cursor: string | null
	limit: number
}): Promise<{
	packages: Array<SavedPackageRecord>
	nextCursor: string | null
}> {
	const packages: Array<SavedPackageRecord> = []
	let cursor = input.cursor
	switch (input.scope.kind) {
		case 'user': {
			const all = await listSavedPackagesByUserId(input.env.APP_DB, {
				userId: input.scope.userId,
			})
			const ordered = (
				await dropOwnersPendingDeletion(
					input.env,
					await applyScopeFilter(
						input.env,
						all.filter((savedPackage) =>
							matchesFilters(savedPackage, input.filters),
						),
						input.filters,
					),
				)
			).sort((left, right) => compareBinaryIds(left.id, right.id))
			const startIndex =
				cursor == null
					? 0
					: ordered.findIndex(
							(savedPackage) => compareBinaryIds(savedPackage.id, cursor!) > 0,
						)
			const sliceStart = startIndex < 0 ? ordered.length : startIndex
			const page = ordered.slice(sliceStart, sliceStart + input.limit)
			packages.push(...page)
			const last = page.at(-1)
			const exhausted =
				page.length < input.limit ||
				last == null ||
				ordered.every(
					(savedPackage) => compareBinaryIds(savedPackage.id, last.id) <= 0,
				)
			return {
				packages,
				nextCursor: exhausted ? null : (last?.id ?? null),
			}
		}
		case 'fleet': {
			let pagesScanned = 0
			for (;;) {
				pagesScanned += 1
				const page = await listSavedPackagesPage(input.env.APP_DB, {
					afterId: cursor,
					limit: fleetScanPageSize,
				})
				if (page.length === 0) {
					return { packages, nextCursor: null }
				}
				const matching = new Set(
					await dropOwnersPendingDeletion(
						input.env,
						await applyScopeFilter(
							input.env,
							page.filter((savedPackage) =>
								matchesFilters(savedPackage, input.filters),
							),
							input.filters,
						),
					),
				)
				for (const savedPackage of page) {
					cursor = savedPackage.id
					if (!matching.has(savedPackage)) continue
					packages.push(savedPackage)
					if (packages.length >= input.limit) {
						return {
							packages,
							nextCursor: savedPackage.id,
						}
					}
				}
				if (page.length < fleetScanPageSize) {
					return { packages, nextCursor: null }
				}
				if (pagesScanned >= maxFleetPagesPerStep) {
					return {
						packages,
						nextCursor: cursor,
					}
				}
			}
		}
		default: {
			const exhaustive: never = input.scope
			throw new Error(`Unknown package codemod scope: ${String(exhaustive)}`)
		}
	}
}

async function detectPublishedDrift(input: {
	env: Env
	repoId: string
	expectedCommit: string
}): Promise<boolean> {
	try {
		const head = await resolveArtifactSourceHead(input.env, input.repoId)
		if (!head.commit) return true
		return head.commit !== input.expectedCommit
	} catch {
		return true
	}
}

function resolvePackageCodemodApplyMode(
	codemod: PackageCodemod,
): PackageCodemodApplyMode {
	return codemod.applyMode ?? 'head-and-published'
}

function usesPublishedOnlyLane(codemod: PackageCodemod) {
	return resolvePackageCodemodApplyMode(codemod) === 'published-only'
}

async function persistItem(
	env: Env,
	result: PersistedItemResult,
	runId: string,
) {
	await insertPackageCodemodRunItem(env.APP_DB, {
		id: result.itemId,
		runId,
		userId: result.userId,
		packageId: result.packageId,
		kodyId: result.kodyId,
		status: result.status,
		beforeCommit: result.beforeCommit,
		afterCommit: result.afterCommit,
		changedPaths: result.changedPaths,
		findings: result.findings,
		checkSummaryJson:
			result.checkSummary == null ? null : JSON.stringify(result.checkSummary),
		error: result.error,
		revertSnapshotKey: result.revertSnapshotKey ?? null,
		ownerDetailJson:
			result.ownerDetail == null ? null : JSON.stringify(result.ownerDetail),
	})
}

async function runChecksOnFiles(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	files: Record<string, string>
	manifestPath: string
	sourceRoot: string
}) {
	return await runRepoChecks({
		workspace: createSnapshotFilesWorkspace(input.files),
		manifestPath: input.manifestPath,
		sourceRoot: input.sourceRoot,
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		requirePackageDocs: false,
		// The engine already walked the import closure for host facts; the
		// warn-only capability check would walk it twice more per item.
		followCapabilityImports: false,
		// Platform migrations must still transform legacy credential patterns
		// before phase 2/3 stamp enforcement (#3836).
		enforceCredentialStamp: false,
	})
}

/**
 * `saved_packages.name` mirrors the published `package.json`, so after an org
 * resource transfer (or a revert of a scope rewrite) it can still carry the
 * previous owner's scope. The registry scope always comes from the owner.
 */
async function buildCodemodContext(input: {
	env: Env
	baseUrl: string
	codemod: PackageCodemod
	files: Record<string, string>
	savedPackage: SavedPackageRecord
	manifestPath: string
	sourceRoot: string
}): Promise<PackageCodemodContext> {
	const ownerScope = await getPackageScopeByUserId(
		input.env.APP_DB,
		input.savedPackage.userId,
	)
	const name = input.savedPackage.name
	const leaf = name.slice(name.indexOf('/') + 1)
	return {
		packageName: `@${ownerScope}/${leaf}`,
		manifestPath: input.manifestPath,
		sourceRoot: input.sourceRoot,
		...(input.codemod.hostFacts?.includes('package-app-capabilities')
			? {
					packageAppCapabilities: await computePackageAppCapabilityHostFacts({
						env: input.env,
						baseUrl: input.baseUrl,
						savedPackage: input.savedPackage,
						files: input.files,
					}),
				}
			: {}),
	}
}

async function processScanItem(input: {
	codemod: PackageCodemod
	savedPackage: SavedPackageRecord
	context: PackageCodemodContext
	files: Record<string, string>
	beforeCommit: string | null
}): Promise<PersistedItemResult> {
	const findings = input.codemod.detect(input.files, input.context)
	const status: PackageCodemodItemStatus =
		findings.length > 0 ? 'detected' : 'clean'
	return emptyItemResult({
		itemId: crypto.randomUUID(),
		userId: input.savedPackage.userId,
		packageId: input.savedPackage.id,
		kodyId: input.savedPackage.kodyId,
		status,
		findings,
		beforeCommit: input.beforeCommit,
	})
}

async function processTransformGates(input: {
	env: Env
	baseUrl: string
	codemod: PackageCodemod
	savedPackage: SavedPackageRecord
	context: PackageCodemodContext
	files: Record<string, string>
	beforeCommit: string | null
	manifestPath: string
	sourceRoot: string
}): Promise<
	| {
			kind: 'terminal'
			result: PersistedItemResult
	  }
	| {
			kind: 'ready'
			itemId: string
			transformedFiles: Record<string, string>
			changedPaths: Array<string>
			findings: Array<PackageCodemodFinding>
			checkSummary: { ok: boolean; newFailures: Array<string> }
			ownerDetail: Record<string, unknown> | null
	  }
> {
	const itemId = crypto.randomUUID()
	const { context } = input
	const transformed = input.codemod.transform(input.files, context)
	if (!transformed.changed && transformed.needsManual.length > 0) {
		return {
			kind: 'terminal',
			result: emptyItemResult({
				itemId,
				userId: input.savedPackage.userId,
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				status: 'needs_manual',
				findings: transformed.needsManual,
				beforeCommit: input.beforeCommit,
				ownerDetail: transformed.ownerDetail,
			}),
		}
	}
	if (!transformed.changed) {
		return {
			kind: 'terminal',
			result: emptyItemResult({
				itemId,
				userId: input.savedPackage.userId,
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				status: 'clean',
				findings: transformed.needsManual,
				beforeCommit: input.beforeCommit,
				ownerDetail: transformed.ownerDetail,
			}),
		}
	}
	const secondPass = input.codemod.transform(transformed.files, context)
	if (secondPass.changed) {
		return {
			kind: 'terminal',
			result: emptyItemResult({
				itemId,
				userId: input.savedPackage.userId,
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				status: 'failed',
				findings: transformed.needsManual,
				changedPaths: transformed.changedPaths,
				beforeCommit: input.beforeCommit,
				ownerDetail: transformed.ownerDetail,
				error:
					'Codemod transform is not idempotent: a second transform pass still reported changes.',
			}),
		}
	}
	const beforeChecks = await runChecksOnFiles({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.savedPackage.userId,
		files: input.files,
		manifestPath: input.manifestPath,
		sourceRoot: input.sourceRoot,
	})
	const afterChecks = await runChecksOnFiles({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.savedPackage.userId,
		files: transformed.files,
		manifestPath: input.manifestPath,
		sourceRoot: input.sourceRoot,
	})
	const checkSummary = computeCheckSummary({
		before: beforeChecks,
		after: afterChecks,
	})
	if (checkSummary.ok && hitCheckRunnerLimit(afterChecks)) {
		return {
			kind: 'terminal',
			result: emptyItemResult({
				itemId,
				userId: input.savedPackage.userId,
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				status: 'failed',
				findings: transformed.needsManual,
				changedPaths: transformed.changedPaths,
				beforeCommit: input.beforeCommit,
				ownerDetail: transformed.ownerDetail,
				error:
					'Repo checks on the transformed tree hit the check runner memory or CPU limits, so the change could not be verified.',
			}),
		}
	}
	if (!checkSummary.ok) {
		return {
			kind: 'terminal',
			result: emptyItemResult({
				itemId,
				userId: input.savedPackage.userId,
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				status: 'dry_run_new_failures',
				findings: transformed.needsManual,
				changedPaths: transformed.changedPaths,
				beforeCommit: input.beforeCommit,
				ownerDetail: transformed.ownerDetail,
				checkSummary,
			}),
		}
	}
	return {
		kind: 'ready',
		itemId,
		transformedFiles: transformed.files,
		changedPaths: transformed.changedPaths,
		findings: transformed.needsManual,
		checkSummary,
		ownerDetail: transformed.ownerDetail ?? null,
	}
}

async function processPackageForMode(input: {
	env: Env
	baseUrl: string
	mode: PackageCodemodRunMode
	codemod: PackageCodemod
	savedPackage: SavedPackageRecord
	runId: string
	waitUntil?: (promise: Promise<unknown>) => void
	subscriptionCache: ReturnType<typeof createPackageCodemodSubscriptionCache>
}): Promise<PersistedItemResult> {
	const loaded = await loadPackageSourceBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.savedPackage.userId,
		sourceId: input.savedPackage.sourceId,
	})
	const publishedCommit = loaded.source.published_commit
	if (publishedCommit == null) {
		return emptyItemResult({
			itemId: crypto.randomUUID(),
			userId: input.savedPackage.userId,
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			status: 'skipped_unpublished',
		})
	}
	const applyMode = resolvePackageCodemodApplyMode(input.codemod)
	const drifted = await detectPublishedDrift({
		env: input.env,
		repoId: loaded.source.repo_id,
		expectedCommit: publishedCommit,
	})
	// published-only codemods may scan/dry-run/apply against the published
	// tree even when default-branch HEAD has moved; head-and-published keeps
	// today's skipped_drift gate.
	if (drifted && applyMode !== 'published-only') {
		return emptyItemResult({
			itemId: crypto.randomUUID(),
			userId: input.savedPackage.userId,
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			status: 'skipped_drift',
			beforeCommit: publishedCommit,
		})
	}

	const context = await buildCodemodContext({
		env: input.env,
		baseUrl: input.baseUrl,
		codemod: input.codemod,
		files: loaded.files,
		savedPackage: input.savedPackage,
		manifestPath: loaded.source.manifest_path,
		sourceRoot: loaded.source.source_root,
	})
	switch (input.mode) {
		case 'scan':
			return await processScanItem({
				codemod: input.codemod,
				savedPackage: input.savedPackage,
				context,
				files: loaded.files,
				beforeCommit: publishedCommit,
			})
		case 'dry-run': {
			const gated = await processTransformGates({
				env: input.env,
				baseUrl: input.baseUrl,
				codemod: input.codemod,
				savedPackage: input.savedPackage,
				context,
				files: loaded.files,
				beforeCommit: publishedCommit,
				manifestPath: loaded.source.manifest_path,
				sourceRoot: loaded.source.source_root,
			})
			if (gated.kind === 'terminal') return gated.result
			return emptyItemResult({
				itemId: gated.itemId,
				userId: input.savedPackage.userId,
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				status: 'dry_run_ok',
				changedPaths: gated.changedPaths,
				findings: gated.findings,
				ownerDetail: gated.ownerDetail,
				beforeCommit: publishedCommit,
				checkSummary: gated.checkSummary,
			})
		}
		case 'apply': {
			const gated = await processTransformGates({
				env: input.env,
				baseUrl: input.baseUrl,
				codemod: input.codemod,
				savedPackage: input.savedPackage,
				context,
				files: loaded.files,
				beforeCommit: publishedCommit,
				manifestPath: loaded.source.manifest_path,
				sourceRoot: loaded.source.source_root,
			})
			if (gated.kind === 'terminal') return gated.result

			const prePublishDrift = await detectPublishedDrift({
				env: input.env,
				repoId: loaded.source.repo_id,
				expectedCommit: publishedCommit,
			})
			const publishedOnlyApply =
				prePublishDrift && applyMode === 'published-only'
			if (prePublishDrift && !publishedOnlyApply) {
				return emptyItemResult({
					itemId: gated.itemId,
					userId: input.savedPackage.userId,
					packageId: input.savedPackage.id,
					kodyId: input.savedPackage.kodyId,
					status: 'skipped_drift',
					changedPaths: gated.changedPaths,
					findings: gated.findings,
					ownerDetail: gated.ownerDetail,
					beforeCommit: publishedCommit,
					checkSummary: gated.checkSummary,
				})
			}
			const revertSnapshotKey = buildPackageCodemodRevertSnapshotKvKey({
				userId: input.savedPackage.userId,
				itemId: gated.itemId,
			})
			const snapshot: CodemodRevertSnapshot = {
				codemodId: input.codemod.id,
				userId: input.savedPackage.userId,
				packageId: input.savedPackage.id,
				beforeCommit: publishedCommit,
				files: loaded.files,
			}
			await input.env.BUNDLE_ARTIFACTS_KV.put(
				revertSnapshotKey,
				JSON.stringify(snapshot),
				{ expirationTtl: revertSnapshotTtlSeconds },
			)

			const locked = isSavedPackageLocked(input.savedPackage.lockedAt)
			// published-only fleet migrations always finalize published_commit
			// (including locked packages via allowLockedPublish) so they never
			// leave a pending approve-publish tip on HEAD or kody-published.
			// Approving a sibling pending HEAD after this uses allowForce on the
			// approve-publish action (owner click is the overwrite confirmation).
			// head-and-published keeps the existing locked → pending path.
			const promotePublished = applyMode === 'published-only' ? true : !locked
			const allowLockedPublish =
				applyMode === 'published-only' && locked ? true : undefined
			const commitMessage = `codemod(${input.codemod.id}): ${input.codemod.description}`

			try {
				const afterCommit = publishedOnlyApply
					? await syncPublishedSourceSnapshotOnly({
							env: input.env,
							baseUrl: input.baseUrl,
							userId: input.savedPackage.userId,
							sourceId: input.savedPackage.sourceId,
							files: gated.transformedFiles,
							expectedPublishedCommit: publishedCommit,
							promotePublished,
							...(allowLockedPublish === true
								? { allowLockedPublish: true }
								: {}),
							commitMessage,
						})
					: await syncArtifactSourceSnapshot({
							env: input.env,
							baseUrl: input.baseUrl,
							userId: input.savedPackage.userId,
							sourceId: input.savedPackage.sourceId,
							files: gated.transformedFiles,
							destructiveOverwriteConfirmed: true,
							// Platform migrations do not wait in the owner approval queue.
							credentialNeedsApproved: true,
							promotePublished,
							...(allowLockedPublish === true
								? { allowLockedPublish: true }
								: {}),
							commitMessage,
							// Align with runChecksOnFiles preflight (requirePackageDocs:
							// false, enforceCredentialStamp: false) so legacy packages
							// without README/AGENTS and pre-stamp credential shapes can
							// publish approved transforms. Other publish checks still run.
							requirePackageDocs: false,
							enforceCredentialStamp: false,
						})
				if (afterCommit == null) {
					return emptyItemResult({
						itemId: gated.itemId,
						userId: input.savedPackage.userId,
						packageId: input.savedPackage.id,
						kodyId: input.savedPackage.kodyId,
						status: 'failed',
						changedPaths: gated.changedPaths,
						findings: gated.findings,
						ownerDetail: gated.ownerDetail,
						beforeCommit: publishedCommit,
						checkSummary: gated.checkSummary,
						revertSnapshotKey,
						error: publishedOnlyApply
							? 'syncPublishedSourceSnapshotOnly returned no published commit. A revert snapshot was retained; default-branch HEAD was not moved.'
							: 'syncArtifactSourceSnapshot returned no published commit. A revert snapshot was retained; repo HEAD may be ahead of published_commit.',
					})
				}
				try {
					await refreshSavedPackageProjection({
						env: input.env,
						baseUrl: input.baseUrl,
						userId: input.savedPackage.userId,
						packageId: input.savedPackage.id,
						sourceId: input.savedPackage.sourceId,
						audit: null,
					})
				} catch (error) {
					console.error(
						JSON.stringify({
							message: 'package-codemod projection refresh failed',
							packageId: input.savedPackage.id,
							error: getErrorMessage(error),
						}),
					)
				}
				await dispatchPackageCodemodSubscriptionEvent({
					env: input.env,
					userId: input.savedPackage.userId,
					topic: packageCodemodAppliedTopic,
					codemodId: input.codemod.id,
					codemodDescription: input.codemod.description,
					packageId: input.savedPackage.id,
					kodyId: input.savedPackage.kodyId,
					runId: input.runId,
					itemId: gated.itemId,
					changedPaths: gated.changedPaths,
					beforeCommit: publishedCommit,
					afterCommit,
					waitUntil: input.waitUntil,
					subscriptionCache: input.subscriptionCache,
				})
				return emptyItemResult({
					itemId: gated.itemId,
					userId: input.savedPackage.userId,
					packageId: input.savedPackage.id,
					kodyId: input.savedPackage.kodyId,
					status: 'applied',
					changedPaths: gated.changedPaths,
					findings: gated.findings,
					ownerDetail: gated.ownerDetail,
					beforeCommit: publishedCommit,
					afterCommit,
					checkSummary: gated.checkSummary,
					revertSnapshotKey,
				})
			} catch (error) {
				return emptyItemResult({
					itemId: gated.itemId,
					userId: input.savedPackage.userId,
					packageId: input.savedPackage.id,
					kodyId: input.savedPackage.kodyId,
					status: 'failed',
					changedPaths: gated.changedPaths,
					findings: gated.findings,
					ownerDetail: gated.ownerDetail,
					beforeCommit: publishedCommit,
					checkSummary: gated.checkSummary,
					revertSnapshotKey,
					error: publishedOnlyApply
						? `${getErrorMessage(error)} A revert snapshot was retained; default-branch HEAD was not moved.`
						: `${getErrorMessage(error)} A revert snapshot was retained; repo HEAD may be ahead of published_commit.`,
				})
			}
		}
		case 'revert':
			throw new Error('processPackageForMode does not handle revert mode.')
		default: {
			const exhaustive: never = input.mode
			throw new Error(`Unknown package codemod mode: ${String(exhaustive)}`)
		}
	}
}

async function processRevertStep(input: {
	env: Env
	baseUrl: string
	codemod: PackageCodemod
	run: PackageCodemodRunRecord
	scope: PackageCodemodRunScope
	cursor: string | null
	limit: number
	waitUntil?: (promise: Promise<unknown>) => void
	subscriptionCache: ReturnType<typeof createPackageCodemodSubscriptionCache>
}): Promise<PackageCodemodRunStepResult> {
	if (!input.run.revertOfRunId) {
		throw new Error('revert mode requires revertOfRunId on the run.')
	}
	const items: Array<PackageCodemodRunItemResult> = []
	const summary: Partial<Record<PackageCodemodItemStatus, number>> = {}
	let cursor = input.cursor
	let pagesFetched = 0
	const scopeUserIdFilter =
		input.scope.kind === 'user' ? input.scope.userId : undefined
	const filters = parseStoredFiltersJson(input.run.filtersJson)
	for (;;) {
		pagesFetched += 1
		const page = await listPackageCodemodRunItems(input.env.APP_DB, {
			runId: input.run.revertOfRunId,
			afterId: cursor,
			limit: fleetScanPageSize,
			status: 'applied',
			...(scopeUserIdFilter != null ? { userId: scopeUserIdFilter } : {}),
		})
		if (page.length === 0) {
			await updatePackageCodemodRunStatus(input.env.APP_DB, {
				id: input.run.id,
				status: 'completed',
			})
			return {
				runId: input.run.id,
				codemodId: input.codemod.id,
				mode: 'revert',
				items,
				nextCursor: null,
				summary,
			}
		}
		const ownersPendingDeletion = await listOwnerIdsPendingDeletion(
			input.env.APP_DB,
			page.map((priorItem) => priorItem.userId),
		)
		for (const priorItem of page) {
			cursor = priorItem.id
			if (input.scope.kind !== 'user' && input.scope.kind !== 'fleet') {
				const exhaustive: never = input.scope
				throw new Error(`Unknown package codemod scope: ${String(exhaustive)}`)
			}
			if (
				!matchesCodemodTargetFilters(
					{
						userId: priorItem.userId,
						packageId: priorItem.packageId,
					},
					filters,
				)
			) {
				// Filter skips advance the cursor but do not count toward limit;
				// the fleet page ceiling still bounds work per step.
				continue
			}
			if (ownersPendingDeletion.has(priorItem.userId)) {
				// Owner is mid-deletion or deleted: account deletion removes this
				// package, so there is nothing to revert. Skip like a filter miss.
				continue
			}
			const itemId = crypto.randomUUID()
			let result: PersistedItemResult
			try {
				const snapshotKey =
					priorItem.revertSnapshotKey ??
					buildPackageCodemodRevertSnapshotKvKey({
						userId: priorItem.userId,
						itemId: priorItem.id,
					})
				const raw = await input.env.BUNDLE_ARTIFACTS_KV.get(snapshotKey)
				if (raw == null) {
					result = emptyItemResult({
						itemId,
						userId: priorItem.userId,
						packageId: priorItem.packageId,
						kodyId: priorItem.kodyId,
						status: 'failed',
						beforeCommit: priorItem.afterCommit,
						error: `Missing revert snapshot for item "${priorItem.id}".`,
					})
				} else {
					const snapshot = JSON.parse(raw) as CodemodRevertSnapshot
					if (
						snapshot.userId !== priorItem.userId ||
						snapshot.packageId !== priorItem.packageId
					) {
						result = emptyItemResult({
							itemId,
							userId: priorItem.userId,
							packageId: priorItem.packageId,
							kodyId: priorItem.kodyId,
							status: 'failed',
							beforeCommit: priorItem.afterCommit,
							error: `Revert snapshot ownership mismatch for item "${priorItem.id}".`,
						})
					} else {
						const savedPackage = (
							await listSavedPackagesByUserId(input.env.APP_DB, {
								userId: priorItem.userId,
							})
						).find((candidate) => candidate.id === priorItem.packageId)
						if (!savedPackage) {
							result = emptyItemResult({
								itemId,
								userId: priorItem.userId,
								packageId: priorItem.packageId,
								kodyId: priorItem.kodyId,
								status: 'failed',
								error: `Saved package "${priorItem.packageId}" was not found for revert.`,
							})
						} else {
							const loaded = await loadPackageSourceBySourceId({
								env: input.env,
								baseUrl: input.baseUrl,
								userId: priorItem.userId,
								sourceId: savedPackage.sourceId,
							})
							const expectedHead = priorItem.afterCommit
							if (expectedHead == null) {
								result = emptyItemResult({
									itemId,
									userId: priorItem.userId,
									packageId: priorItem.packageId,
									kodyId: priorItem.kodyId,
									status: 'failed',
									error: `Applied item "${priorItem.id}" is missing afterCommit for revert drift check.`,
								})
							} else {
								const head = await resolveArtifactSourceHead(
									input.env,
									loaded.source.repo_id,
								)
								const headMatchesAfter = head.commit === priorItem.afterCommit
								// Aligned apply (HEAD still at afterCommit) must revert via
								// syncArtifactSourceSnapshot so HEAD and published stay
								// together. Published-only apply left HEAD alone — revert
								// only when published_commit is still at after/before.
								const publishedOnlyRevert =
									usesPublishedOnlyLane(input.codemod) && !headMatchesAfter
								if (publishedOnlyRevert) {
									const publishedCommit = loaded.source.published_commit
									const publishedStillAtAfter =
										publishedCommit === priorItem.afterCommit
									// Require published tip still at afterCommit. A locked
									// aligned apply leaves published at beforeCommit while
									// HEAD holds the pending commit — if HEAD then drifted,
									// published-only "revert" would no-op and falsely mark
									// reverted while approve-publish can still promote it.
									if (publishedCommit == null || !publishedStillAtAfter) {
										result = emptyItemResult({
											itemId,
											userId: priorItem.userId,
											packageId: priorItem.packageId,
											kodyId: priorItem.kodyId,
											status: 'skipped_drift',
											beforeCommit: priorItem.afterCommit,
											error:
												publishedCommit === priorItem.beforeCommit
													? 'Published commit is still at the pre-apply tip while HEAD has moved; unlock/align before revert so a pending HEAD commit is not left publishable.'
													: null,
										})
									} else {
										const locked = isSavedPackageLocked(savedPackage.lockedAt)
										const afterCommit = await syncPublishedSourceSnapshotOnly({
											env: input.env,
											baseUrl: input.baseUrl,
											userId: priorItem.userId,
											sourceId: savedPackage.sourceId,
											files: snapshot.files,
											expectedPublishedCommit: publishedCommit,
											promotePublished: true,
											...(locked ? { allowLockedPublish: true } : {}),
											commitMessage: `revert codemod(${input.codemod.id})`,
										})
										if (afterCommit == null) {
											result = emptyItemResult({
												itemId,
												userId: priorItem.userId,
												packageId: priorItem.packageId,
												kodyId: priorItem.kodyId,
												status: 'failed',
												error:
													'syncPublishedSourceSnapshotOnly returned no published commit.',
											})
										} else {
											try {
												await refreshSavedPackageProjection({
													env: input.env,
													baseUrl: input.baseUrl,
													userId: priorItem.userId,
													packageId: priorItem.packageId,
													sourceId: savedPackage.sourceId,
													audit: null,
												})
											} catch (error) {
												console.error(
													JSON.stringify({
														message:
															'package-codemod revert projection refresh failed',
														packageId: priorItem.packageId,
														error: getErrorMessage(error),
													}),
												)
											}
											await dispatchPackageCodemodSubscriptionEvent({
												env: input.env,
												userId: priorItem.userId,
												topic: packageCodemodRevertedTopic,
												codemodId: input.codemod.id,
												codemodDescription: input.codemod.description,
												packageId: priorItem.packageId,
												kodyId: priorItem.kodyId,
												runId: input.run.id,
												itemId,
												changedPaths: priorItem.changedPaths,
												beforeCommit: priorItem.afterCommit,
												afterCommit,
												waitUntil: input.waitUntil,
												subscriptionCache: input.subscriptionCache,
											})
											await updatePackageCodemodRunItem(input.env.APP_DB, {
												id: priorItem.id,
												status: 'reverted',
											})
											result = emptyItemResult({
												itemId,
												userId: priorItem.userId,
												packageId: priorItem.packageId,
												kodyId: priorItem.kodyId,
												status: 'reverted',
												changedPaths: priorItem.changedPaths,
												beforeCommit: priorItem.afterCommit,
												afterCommit,
											})
										}
									}
								} else {
									const drifted = await detectPublishedDrift({
										env: input.env,
										repoId: loaded.source.repo_id,
										expectedCommit: expectedHead,
									})
									if (drifted) {
										result = emptyItemResult({
											itemId,
											userId: priorItem.userId,
											packageId: priorItem.packageId,
											kodyId: priorItem.kodyId,
											status: 'skipped_drift',
											beforeCommit: priorItem.afterCommit,
										})
									} else {
										const locked = isSavedPackageLocked(savedPackage.lockedAt)
										const publishedOnlyAlignedRevert = usesPublishedOnlyLane(
											input.codemod,
										)
										const afterCommit = await syncArtifactSourceSnapshot({
											env: input.env,
											baseUrl: input.baseUrl,
											userId: priorItem.userId,
											sourceId: savedPackage.sourceId,
											files: snapshot.files,
											destructiveOverwriteConfirmed: true,
											credentialNeedsApproved: true,
											promotePublished: publishedOnlyAlignedRevert
												? true
												: !locked,
											...(publishedOnlyAlignedRevert && locked
												? { allowLockedPublish: true }
												: {}),
											commitMessage: `revert codemod(${input.codemod.id})`,
											// Same docs + stamp exemptions as apply and preflight.
											requirePackageDocs: false,
											enforceCredentialStamp: false,
										})
										if (afterCommit == null) {
											result = emptyItemResult({
												itemId,
												userId: priorItem.userId,
												packageId: priorItem.packageId,
												kodyId: priorItem.kodyId,
												status: 'failed',
												error:
													'syncArtifactSourceSnapshot returned no published commit.',
											})
										} else {
											try {
												await refreshSavedPackageProjection({
													env: input.env,
													baseUrl: input.baseUrl,
													userId: priorItem.userId,
													packageId: priorItem.packageId,
													sourceId: savedPackage.sourceId,
													audit: null,
												})
											} catch (error) {
												console.error(
													JSON.stringify({
														message:
															'package-codemod revert projection refresh failed',
														packageId: priorItem.packageId,
														error: getErrorMessage(error),
													}),
												)
											}
											await dispatchPackageCodemodSubscriptionEvent({
												env: input.env,
												userId: priorItem.userId,
												topic: packageCodemodRevertedTopic,
												codemodId: input.codemod.id,
												codemodDescription: input.codemod.description,
												packageId: priorItem.packageId,
												kodyId: priorItem.kodyId,
												runId: input.run.id,
												itemId,
												changedPaths: priorItem.changedPaths,
												beforeCommit: priorItem.afterCommit,
												afterCommit,
												waitUntil: input.waitUntil,
												subscriptionCache: input.subscriptionCache,
											})
											await updatePackageCodemodRunItem(input.env.APP_DB, {
												id: priorItem.id,
												status: 'reverted',
											})
											result = emptyItemResult({
												itemId,
												userId: priorItem.userId,
												packageId: priorItem.packageId,
												kodyId: priorItem.kodyId,
												status: 'reverted',
												changedPaths: priorItem.changedPaths,
												beforeCommit: priorItem.afterCommit,
												afterCommit,
											})
										}
									}
								}
							}
						}
					}
				}
			} catch (error) {
				result = emptyItemResult({
					itemId,
					userId: priorItem.userId,
					packageId: priorItem.packageId,
					kodyId: priorItem.kodyId,
					status: 'failed',
					error: getErrorMessage(error),
				})
			}
			await persistItem(input.env, result, input.run.id)
			items.push(toPublicItem(result))
			incrementSummary(summary, result.status)
			if (items.length >= input.limit) {
				return {
					runId: input.run.id,
					codemodId: input.codemod.id,
					mode: 'revert',
					items,
					nextCursor: cursor,
					summary,
				}
			}
		}
		if (page.length < fleetScanPageSize) {
			await updatePackageCodemodRunStatus(input.env.APP_DB, {
				id: input.run.id,
				status: 'completed',
			})
			return {
				runId: input.run.id,
				codemodId: input.codemod.id,
				mode: 'revert',
				items,
				nextCursor: null,
				summary,
			}
		}
		if (pagesFetched >= maxFleetPagesPerStep) {
			return {
				runId: input.run.id,
				codemodId: input.codemod.id,
				mode: 'revert',
				items,
				nextCursor: cursor,
				summary,
			}
		}
	}
}

/**
 * A package whose processing kills the step (out of CPU or memory) never
 * reaches the per-item catch, so the same cursor would fail forever. Each
 * scan or dry-run attempt is counted before processing and cleared after;
 * past the limit the package is recorded as failed and paging moves on. A
 * retried page skips packages this run already recorded.
 */
const maxUnfinishedAttempts = 2
const unfinishedAttemptTtlSeconds = 7 * 24 * 60 * 60
export const operatorExcludedFinding: PackageCodemodFinding = {
	path: null,
	message:
		'Excluded from this run by the operator; handle this package manually.',
}
export const unfinishedAttemptsError =
	'Skipped: earlier attempts on this package did not finish (the step ran out of time or memory).'

function unfinishedAttemptKvKey(runId: string, packageId: string) {
	return `package-codemod-attempt:${runId}:${packageId}`
}

export async function runPackageCodemodStep(input: {
	env: Env
	baseUrl: string
	initiatedByUserId: string
	codemodId: string
	mode: PackageCodemodRunMode
	scope: PackageCodemodRunScope
	filters?: PackageCodemodRunFilters
	runId?: string
	cursor?: string | null
	limit?: number
	revertOfRunId?: string
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<PackageCodemodRunStepResult> {
	const codemod = getPackageCodemodById(input.codemodId)
	if (!codemod) {
		throw new Error(`Unknown package codemod "${input.codemodId}".`)
	}
	switch (input.mode) {
		case 'scan':
		case 'dry-run':
		case 'apply':
		case 'revert':
			break
		default: {
			const exhaustive: never = input.mode
			throw new Error(`Unknown package codemod mode: ${String(exhaustive)}`)
		}
	}
	const limit = resolveStepLimit(input.mode, input.limit)
	if (input.mode === 'revert' && !input.revertOfRunId && !input.runId) {
		throw new Error('revert mode requires revertOfRunId.')
	}
	// A cursor is only meaningful when continuing an existing run; accepting
	// one on a fresh run would silently skip everything before the cursor.
	if (input.cursor != null && !input.runId) {
		throw new Error('cursor requires runId to continue an existing run.')
	}
	const run = await ensureRun({
		env: input.env,
		runId: input.runId,
		codemodId: input.codemodId,
		mode: input.mode,
		scope: input.scope,
		initiatedByUserId: input.initiatedByUserId,
		filters: input.filters,
		revertOfRunId: input.revertOfRunId,
	})
	try {
		const subscriptionCache = createPackageCodemodSubscriptionCache()
		if (input.mode === 'revert') {
			return await processRevertStep({
				env: input.env,
				baseUrl: input.baseUrl,
				codemod,
				run,
				scope: input.scope,
				cursor: input.cursor ?? null,
				limit,
				waitUntil: input.waitUntil,
				subscriptionCache,
			})
		}

		const filters = input.filters ?? parseStoredFiltersJson(run.filtersJson)
		const excluded = new Set(filters.excludePackageIds ?? [])
		const { packages, nextCursor } = await listCandidatePackages({
			env: input.env,
			scope: input.scope,
			filters,
			cursor: input.cursor ?? null,
			limit,
		})
		const items: Array<PackageCodemodRunItemResult> = []
		const summary: Partial<Record<PackageCodemodItemStatus, number>> = {}
		for (const savedPackage of packages) {
			let result: PersistedItemResult
			// Read-only modes only: an interrupted apply may already have
			// published, so it must not be recorded as a plain failure.
			const tracksAttempts = input.mode !== 'apply'
			if (
				tracksAttempts &&
				(await hasPackageCodemodRunItemForPackage(input.env.APP_DB, {
					runId: run.id,
					packageId: savedPackage.id,
				}))
			) {
				continue
			}
			if (excluded.has(savedPackage.id)) {
				result = emptyItemResult({
					itemId: crypto.randomUUID(),
					userId: savedPackage.userId,
					packageId: savedPackage.id,
					kodyId: savedPackage.kodyId,
					status: 'needs_manual',
					findings: [operatorExcludedFinding],
				})
				await persistItem(input.env, result, run.id)
				items.push(toPublicItem(result))
				incrementSummary(summary, result.status)
				continue
			}
			const attemptKey = unfinishedAttemptKvKey(run.id, savedPackage.id)
			const unfinishedAttempts = tracksAttempts
				? Number((await input.env.BUNDLE_ARTIFACTS_KV.get(attemptKey)) ?? 0)
				: 0
			if (unfinishedAttempts >= maxUnfinishedAttempts) {
				result = emptyItemResult({
					itemId: crypto.randomUUID(),
					userId: savedPackage.userId,
					packageId: savedPackage.id,
					kodyId: savedPackage.kodyId,
					status: 'failed',
					error: unfinishedAttemptsError,
				})
				await persistItem(input.env, result, run.id)
				await input.env.BUNDLE_ARTIFACTS_KV.delete(attemptKey)
				items.push(toPublicItem(result))
				incrementSummary(summary, result.status)
				continue
			}
			if (tracksAttempts) {
				await input.env.BUNDLE_ARTIFACTS_KV.put(
					attemptKey,
					String(unfinishedAttempts + 1),
					{ expirationTtl: unfinishedAttemptTtlSeconds },
				)
			}
			try {
				result = await processPackageForMode({
					env: input.env,
					baseUrl: input.baseUrl,
					mode: input.mode,
					codemod,
					savedPackage,
					runId: run.id,
					waitUntil: input.waitUntil,
					subscriptionCache,
				})
			} catch (error) {
				result = emptyItemResult({
					itemId: crypto.randomUUID(),
					userId: savedPackage.userId,
					packageId: savedPackage.id,
					kodyId: savedPackage.kodyId,
					status: 'failed',
					error: getErrorMessage(error),
				})
			}
			try {
				await persistItem(input.env, result, run.id)
			} finally {
				if (tracksAttempts) {
					await input.env.BUNDLE_ARTIFACTS_KV.delete(attemptKey)
				}
			}
			items.push(toPublicItem(result))
			incrementSummary(summary, result.status)
		}
		if (nextCursor == null) {
			await updatePackageCodemodRunStatus(input.env.APP_DB, {
				id: run.id,
				status: 'completed',
			})
		}
		return {
			runId: run.id,
			codemodId: input.codemodId,
			mode: input.mode,
			items,
			nextCursor,
			summary,
		}
	} catch (error) {
		// Per-package failures are isolated above; only step-level failures
		// (paging, ledger writes, unexpected throws) reach here. Without this
		// the run would sit in `running` forever, since the caller never gets
		// a cursor back to continue with. A later continuation step reopens
		// the run via the ensureRun heartbeat.
		try {
			await updatePackageCodemodRunStatus(input.env.APP_DB, {
				id: run.id,
				status: 'failed',
			})
		} catch {
			// Best-effort: surface the original step error, not the status write.
		}
		throw error
	}
}
