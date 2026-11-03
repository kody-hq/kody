/**
 * Fleet scan/restamp for credential stamps (issue #3836 phase 2).
 *
 * dryRun (default) reports stamp presence and seal readiness across published
 * packages. Apply writes a stamp at the current published_commit only when the
 * package source is already seal-ready (every stamp key has a description and
 * no blocking gate failures). Packages that need manifest edits go through
 * codemod `0014-seal-credential-stamps`; packages with unconvertible patterns
 * are reported as `unconvertible` for an agent attempt then Kent notify.
 * Durable Object CPU / isolate-reset failures (large prebuilt client assets)
 * are `deferred_scan_budget` — a known publish-path bug, not stop-and-notify.
 */
import {
	errorCauseChainIncludes,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import { isDurableObjectIsolateResetMessage } from '#worker/sentry-options.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { listSavedPackagesPage } from '#worker/package-registry/repo.ts'
import {
	loadPackageSourceBySourceId,
	loadPackageSourceRowForUser,
} from '#worker/package-registry/source.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import { readPublishedCredentialStamp } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { packageSourceFiles } from './credential-needs-closure.ts'
import {
	isStoredCredentialStamp,
	omitOversizedCredentialStampModules,
	planCredentialStampSeal,
	type CredentialStamp,
	type CredentialStampGateFailure,
} from './credential-stamp.ts'
import {
	resolvePublishedCredentialDepStamps,
	storePublishedCredentialStamp,
} from './credential-stamp-store.ts'

export const credentialStampFleetScanPageSize = 50
export const credentialStampFleetScanLimitDefault = 50
export const credentialStampFleetScanLimitMax = 200
export const credentialStampFleetApplyLimitDefault = 5
export const credentialStampFleetApplyLimitMax = 10

/** Max blockingFailures samples per unconvertible outcome (response budget). */
export const credentialStampFleetFailureSampleMax = 3
/** Truncate each sampled failure message for execute response budgets. */
export const credentialStampFleetFailureMessageMax = 120

/**
 * Sample blocking failures for fleet dry-run: at least one example per distinct
 * code (when possible), then fill remaining slots. Truncates messages so a
 * full unconvertible page stays within the execute result budget.
 */
export function sampleFleetBlockingFailures(
	failures: ReadonlyArray<CredentialStampGateFailure>,
): Array<CredentialStampGateFailure> {
	const truncate = (
		failure: CredentialStampGateFailure,
	): CredentialStampGateFailure => ({
		code: failure.code,
		message:
			failure.message.length > credentialStampFleetFailureMessageMax
				? `${failure.message.slice(0, credentialStampFleetFailureMessageMax - 1)}…`
				: failure.message,
		...(failure.path ? { path: failure.path } : {}),
	})
	const byCode = new Map<string, CredentialStampGateFailure>()
	const extras: Array<CredentialStampGateFailure> = []
	for (const failure of failures) {
		const sampled = truncate(failure)
		if (!byCode.has(failure.code)) byCode.set(failure.code, sampled)
		else extras.push(sampled)
	}
	const out = [...byCode.values()]
	for (const failure of extras) {
		if (out.length >= credentialStampFleetFailureSampleMax) break
		out.push(failure)
	}
	return out.slice(0, credentialStampFleetFailureSampleMax)
}

export type CredentialStampFleetOutcome =
	| {
			packageId: string
			ownerUserId: OwnerId
			packageName: string
			kodyId: string
			sourceId: string
			publishedCommit: string
			stampKeyCount: number
			outcome: 'stamped' | 'would_restamp' | 'restamped' | 'needs_manifest'
	  }
	| {
			packageId: string
			ownerUserId: OwnerId
			packageName: string
			kodyId: string
			sourceId: string
			publishedCommit: string
			stampKeyCount: number
			outcome: 'unconvertible'
			/** Distinct blocking gate codes for this package (sample before stop-and-notify). */
			blockingFailureCodes: Array<CredentialStampGateFailure['code']>
			/** Cap of blocking failures (path + message) for FP sampling. */
			blockingFailures: Array<CredentialStampGateFailure>
	  }
	| {
			packageId: string
			ownerUserId: OwnerId
			packageName: string
			kodyId: string
			sourceId: string
			publishedCommit: null
			stampKeyCount: number
			outcome: 'skipped_unpublished'
	  }
	| {
			packageId: string
			ownerUserId: OwnerId
			packageName: string
			kodyId: string
			sourceId: string
			publishedCommit: string | null
			stampKeyCount: number
			outcome: 'deferred_scan_budget'
			error: string
	  }
	| {
			packageId: string
			ownerUserId: OwnerId
			packageName: string
			kodyId: string
			sourceId: string
			publishedCommit: string | null
			stampKeyCount: number
			outcome: 'failed'
			error: string
	  }

export type CredentialStampFleetResult = {
	dryRun: boolean
	scannedPackages: number
	publishedPackages: number
	stampedPackages: number
	missingStampPackages: number
	needsManifestPackages: number
	unconvertiblePackages: number
	/** DO CPU / isolate-reset failures — known bug, not stop-and-notify. */
	deferredScanBudgetPackages: number
	restampedPackages: number
	failedPackages: number
	skippedUnpublished: number
	nextCursor: string | null
	outcomes: Array<CredentialStampFleetOutcome>
	/** Blocking failure codes seen on unconvertible packages this page. */
	unconvertibleFailureCodes: Array<CredentialStampGateFailure['code']>
}

/**
 * True when a single error message is a known Durable Object CPU / isolate
 * reset (or BudgetLimitError name) from large-asset stamp seal. Walk the
 * cause chain via {@link isCredentialStampScanBudgetFailure}.
 */
function isCredentialStampScanBudgetMessage(message: string): boolean {
	if (isDurableObjectIsolateResetMessage(message)) return true
	return (
		/\bBudgetLimitError\b/.test(message) ||
		/\bDurable Object reset because of CPU time limit\b/i.test(message) ||
		/\bWorker exceeded CPU time limit\b/i.test(message) ||
		/\bscript exceeded CPU time limit\b/i.test(message)
	)
}

/**
 * True when the failure is the known Durable Object CPU blowup on large
 * prebuilt client assets (publish seal / fleet scan), not an unconvertible
 * credential pattern. Walks `error.cause` the same way load/store paths do.
 * Do not stop-and-notify Kent for these.
 */
export function isCredentialStampScanBudgetFailure(error: unknown): boolean {
	return errorCauseChainIncludes(error, isCredentialStampScanBudgetMessage)
}

function sortedKeyList(keys: ReadonlyArray<unknown>): Array<string> {
	return keys
		.filter((key): key is string => typeof key === 'string')
		.slice()
		.sort()
}

function stampKeysMatchPlan(
	stamp: CredentialStamp,
	planKeys: ReadonlyArray<string>,
): boolean {
	const left = sortedKeyList(stamp.keys)
	const right = sortedKeyList(planKeys)
	if (left.length !== right.length) return false
	return left.every((key, index) => key === right[index])
}

function depStampPinKey(dep: {
	packageId: string
	publishedCommit: string
	stampHash: string
}): string {
	return `${dep.packageId}\0${dep.publishedCommit}\0${dep.stampHash}`
}

function stampDepPinsMatch(
	stamp: CredentialStamp,
	liveDeps: ReadonlyArray<{
		packageId: string
		publishedCommit: string
		stampHash: string
	}>,
): boolean {
	const left = stamp.depStamps.map(depStampPinKey).sort()
	const right = liveDeps.map(depStampPinKey).sort()
	if (left.length !== right.length) return false
	return left.every((key, index) => key === right[index])
}

function matchesOptionalFilters(
	savedPackage: SavedPackageRecord,
	filters: {
		packageIds?: ReadonlySet<string>
		ownerUserIds?: ReadonlySet<string>
		sourceIds?: ReadonlySet<string>
	},
) {
	if (filters.packageIds && !filters.packageIds.has(savedPackage.id)) {
		return false
	}
	if (filters.ownerUserIds && !filters.ownerUserIds.has(savedPackage.userId)) {
		return false
	}
	if (filters.sourceIds && !filters.sourceIds.has(savedPackage.sourceId)) {
		return false
	}
	return true
}

async function listCandidatePackages(input: {
	env: Env
	afterId: string | null
	limit: number
	packageIds?: ReadonlySet<string>
	ownerUserIds?: ReadonlySet<string>
	sourceIds?: ReadonlySet<string>
}): Promise<{
	packages: Array<SavedPackageRecord>
	nextCursor: string | null
}> {
	const packages: Array<SavedPackageRecord> = []
	let cursor = input.afterId
	let pagesScanned = 0
	const maxPages = 20
	for (;;) {
		pagesScanned += 1
		const page = await listSavedPackagesPage(input.env.APP_DB, {
			afterId: cursor,
			limit: credentialStampFleetScanPageSize,
		})
		if (page.length === 0) {
			return { packages, nextCursor: null }
		}
		for (const savedPackage of page) {
			cursor = savedPackage.id
			if (!matchesOptionalFilters(savedPackage, input)) continue
			packages.push(savedPackage)
			if (packages.length >= input.limit) {
				return { packages, nextCursor: savedPackage.id }
			}
		}
		if (page.length < credentialStampFleetScanPageSize) {
			return { packages, nextCursor: null }
		}
		if (pagesScanned >= maxPages) {
			return { packages, nextCursor: cursor }
		}
	}
}

/**
 * Fleet scan/apply for published packages missing a complete credential stamp
 * at the current published commit. dryRun (default) reports only; apply
 * restamps seal-ready packages with no content change.
 */
export async function runCredentialStampFleet(input: {
	env: Env
	baseUrl: string
	dryRun?: boolean
	afterId?: string | null
	limit?: number
	packageIds?: ReadonlyArray<string>
	ownerUserIds?: ReadonlyArray<string>
	sourceIds?: ReadonlyArray<string>
}): Promise<CredentialStampFleetResult> {
	const dryRun = input.dryRun !== false
	const limit = Math.max(
		1,
		Math.min(
			input.limit ??
				(dryRun
					? credentialStampFleetScanLimitDefault
					: credentialStampFleetApplyLimitDefault),
			dryRun
				? credentialStampFleetScanLimitMax
				: credentialStampFleetApplyLimitMax,
		),
	)
	const packageIds = input.packageIds?.length
		? new Set(input.packageIds.map((id) => id.trim()).filter(Boolean))
		: undefined
	const ownerUserIds = input.ownerUserIds?.length
		? new Set(input.ownerUserIds.map((id) => id.trim()).filter(Boolean))
		: undefined
	const sourceIds = input.sourceIds?.length
		? new Set(input.sourceIds.map((id) => id.trim()).filter(Boolean))
		: undefined

	const { packages, nextCursor } = await listCandidatePackages({
		env: input.env,
		afterId: input.afterId ?? null,
		limit,
		packageIds,
		ownerUserIds,
		sourceIds,
	})

	const outcomes: Array<CredentialStampFleetOutcome> = []
	const unconvertibleFailureCodes = new Set<
		CredentialStampGateFailure['code']
	>()
	let publishedPackages = 0
	let stampedPackages = 0
	let missingStampPackages = 0
	let needsManifestPackages = 0
	let unconvertiblePackages = 0
	let deferredScanBudgetPackages = 0
	let restampedPackages = 0
	let failedPackages = 0
	let skippedUnpublished = 0

	for (const savedPackage of packages) {
		let publishedCommit: string | null = null
		try {
			const source = await loadPackageSourceRowForUser({
				env: input.env,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
			})
			publishedCommit = source.published_commit?.trim() || null
			if (!publishedCommit) {
				skippedUnpublished += 1
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit: null,
					stampKeyCount: 0,
					outcome: 'skipped_unpublished',
				})
				continue
			}
			publishedPackages += 1
			const loaded = await loadPackageSourceBySourceId({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
			})
			const loadedCommit = loaded.source.published_commit?.trim() || null
			if (loadedCommit !== publishedCommit) {
				throw new Error(
					`Published commit changed from "${publishedCommit}" to "${loadedCommit ?? 'unpublished'}" while scanning; retry this package.`,
				)
			}
			// Nested packages arrive keyed from the repo root; scope like
			// storePublishedCredentialStamp / packageSourceFiles before seal.
			const { files: packageFiles } = packageSourceFiles({
				source: loaded.source,
				files: loaded.files,
			})
			const plan = planCredentialStampSeal(packageFiles)
			// Seal-plan scan size, not declared package.json slot count. A
			// package can be outcome "stamped" with stampKeyCount 0 when the
			// scan misses uses (e.g. cm.mcp?.['home'] before optional/bracket
			// detection) and the stored stamp is also empty — they still match.
			const stampKeyCount = plan.keys.length
			if (plan.blockingFailures.length > 0) {
				unconvertiblePackages += 1
				for (const failure of plan.blockingFailures) {
					unconvertibleFailureCodes.add(failure.code)
				}
				const blockingFailureCodes = [
					...new Set(plan.blockingFailures.map((failure) => failure.code)),
				].sort()
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit,
					stampKeyCount,
					outcome: 'unconvertible',
					blockingFailureCodes,
					blockingFailures: sampleFleetBlockingFailures(plan.blockingFailures),
				})
				continue
			}
			if (plan.uninferableKeys.length > 0 || plan.updates.length > 0) {
				needsManifestPackages += 1
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit,
					stampKeyCount,
					outcome: 'needs_manifest',
				})
				continue
			}
			const existing = await readPublishedCredentialStamp({
				env: input.env,
				sourceId: source.id,
				publishedCommit,
			})
			const liveDepPins = isStoredCredentialStamp(existing)
				? await resolvePublishedCredentialDepStamps({
						env: input.env,
						userId: savedPackage.userId,
						packageName: savedPackage.name,
						// Same oversized omit as seal planning / loadDependencyStamps.
						files: omitOversizedCredentialStampModules(packageFiles),
					})
				: []
			const stampCurrent =
				isStoredCredentialStamp(existing) &&
				stampKeysMatchPlan(existing, plan.keys) &&
				stampDepPinsMatch(existing, liveDepPins)
			if (stampCurrent) {
				stampedPackages += 1
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit,
					stampKeyCount,
					outcome: 'stamped',
				})
				continue
			}
			missingStampPackages += 1
			if (dryRun) {
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit,
					stampKeyCount,
					outcome: 'would_restamp',
				})
				continue
			}
			const sourceAgain = await loadPackageSourceRowForUser({
				env: input.env,
				userId: savedPackage.userId,
				sourceId: savedPackage.sourceId,
			})
			const commitAgain = sourceAgain.published_commit?.trim() || null
			if (commitAgain !== publishedCommit) {
				throw new Error(
					`Published commit changed from "${publishedCommit}" to "${commitAgain ?? 'unpublished'}" before restamp; retry this package.`,
				)
			}
			const stored = await storePublishedCredentialStamp({
				env: input.env,
				source: sourceAgain,
				publishedCommit,
				files: loaded.files,
			})
			if (stored == null) {
				throw new Error(
					`Failed to store credential stamp for source "${source.id}" at commit "${publishedCommit}".`,
				)
			}
			restampedPackages += 1
			outcomes.push({
				packageId: savedPackage.id,
				ownerUserId: savedPackage.userId,
				packageName: savedPackage.name,
				kodyId: savedPackage.kodyId,
				sourceId: savedPackage.sourceId,
				publishedCommit,
				stampKeyCount,
				outcome: 'restamped',
			})
		} catch (error) {
			if (isCredentialStampScanBudgetFailure(error)) {
				deferredScanBudgetPackages += 1
				outcomes.push({
					packageId: savedPackage.id,
					ownerUserId: savedPackage.userId,
					packageName: savedPackage.name,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
					publishedCommit,
					stampKeyCount: 0,
					outcome: 'deferred_scan_budget',
					error: getErrorMessage(error),
				})
				continue
			}
			failedPackages += 1
			outcomes.push({
				packageId: savedPackage.id,
				ownerUserId: savedPackage.userId,
				packageName: savedPackage.name,
				kodyId: savedPackage.kodyId,
				sourceId: savedPackage.sourceId,
				publishedCommit,
				stampKeyCount: 0,
				outcome: 'failed',
				error: getErrorMessage(error),
			})
		}
	}

	return {
		dryRun,
		scannedPackages: packages.length,
		publishedPackages,
		stampedPackages,
		missingStampPackages,
		needsManifestPackages,
		unconvertiblePackages,
		deferredScanBudgetPackages,
		restampedPackages,
		failedPackages,
		skippedUnpublished,
		nextCursor,
		outcomes,
		unconvertibleFailureCodes: [...unconvertibleFailureCodes].sort(),
	}
}
