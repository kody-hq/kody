import type { JobRecord } from '@kody-internal/shared/jobs/types.ts'
import { mapWithConcurrency } from '#worker/admin/insights-runlog-snapshot.ts'
import {
	resolvePackageForProvenance,
	type PackageProvenanceTarget,
} from '#worker/admin/package-provenance.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { loadServingPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { collectPublishedPackageArtifactTargets } from '#worker/package-runtime/package-artifact-targets.ts'
import {
	matchesPublishedBundleArtifactIdentity,
	normalizeArtifactName,
	normalizeEntryPoint,
} from '#worker/package-runtime/published-bundle-artifact-persist.ts'
import {
	buildPublishedBundleArtifactKvKey,
	isUsableStoredPublishedBundleArtifact,
	type BundleArtifactKind,
	type PublishedBundleArtifact,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import {
	listPublishedBundleArtifactsBySourceId,
	type PublishedBundleArtifactRecord,
} from '#worker/repo/published-bundle-artifacts-repo.ts'
import {
	servingArtifactCommitForSource,
	servingCommitForSource,
} from '#worker/repo/serving-commit.ts'

export const packageArtifactEvidenceDefaultLimit = 10
export const packageArtifactEvidenceMaxLimit = 20
/** Per-target module hash list cap; `moduleCount` is always the full count. */
export const packageArtifactEvidenceModuleListLimit = 32
const kvReadConcurrency = 4
const commitShaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const bundleArtifactKinds = new Set<string>([
	'app',
	'app-client',
	'importable-module',
	'job',
	'module',
])

/**
 * Which commit each runtime reader passes as `commit` to
 * `loadPublishedBundleArtifactByIdentity`:
 * - `serving_commit`: `servingCommitForSource` (callable modules and
 *   subscriptions in `module-artifacts.ts`, app and app-client in
 *   `package-app.ts` / `package-app-assets.ts`, jobs in `jobs/service.ts`).
 * - `serving_artifact_commit`: `servingArtifactCommitForSource` (importable
 *   modules in `module-graph-hydration.ts` / `module-graph-import-rewriting.ts`);
 *   null there means the reader uses the newest identity row as-is.
 */
export type RuntimeArtifactSelector =
	| 'serving_commit'
	| 'serving_artifact_commit'

export function runtimeSelectorForArtifactKind(
	kind: BundleArtifactKind,
): RuntimeArtifactSelector {
	return kind === 'importable-module'
		? 'serving_artifact_commit'
		: 'serving_commit'
}

export type ArtifactPayloadStatus =
	| 'valid'
	| 'missing'
	| 'malformed'
	| 'identity_mismatch'
	| 'kv_unavailable'

export type ArtifactPayloadEvidence = {
	commit: string | null
	kvKey: string | null
	kvKeyDerived: boolean
	status: ArtifactPayloadStatus
	malformedReason:
		| 'invalid_json'
		| 'not_object'
		| 'unsupported_version'
		| 'invalid_modules'
		| null
	identityMismatchFields: Array<string>
	embeddedCommit: string | null
	embeddedCommitMatches: boolean | null
	mainModule: string | null
	mainModuleSha256: string | null
	bundleSha256: string | null
	moduleCount: number | null
	modules: Array<{ path: string; sha256: string }>
	modulesTruncated: boolean
	sizeBytes: number | null
}

export type ArtifactEvidenceTarget = {
	key: string
	kind: BundleArtifactKind
	artifactName: string | null
	entryPoint: string | null
	declared: boolean
	selector: RuntimeArtifactSelector
	identityRow: {
		builtFromCommit: string
		builtFromCommitValid: boolean
		updatedAt: string
	} | null
	/**
	 * The payload a runtime reader selects (the serving-commit key, or the
	 * newest row's key when the selector has no commit). When the identity row
	 * is missing, runtime returns no artifact; this still probes the
	 * commit-keyed key so missing and orphaned payloads are visible.
	 */
	selected: ArtifactPayloadEvidence | null
	/** Runtime would load `selected` (identity row present and payload valid). */
	runtimeLoads: boolean
	/** Newest identity row payload, only when it names a different commit. */
	newestRow: Omit<ArtifactPayloadEvidence, 'modules'> | null
	selectedMatchesNewestRowBytes: boolean | null
	jobs: Array<{
		jobId: string
		enabled: boolean
		recordedCommit: string | null
	}>
}

export type PackageArtifactEvidence = {
	package: {
		packageId: string
		name: string
		ownerId: string
		sourceId: string
	}
	source: {
		publishedCommit: string | null
		servingCommit: string | null
		servingArtifactCommit: string | null
	} | null
	manifest: {
		status: 'loaded' | 'unavailable'
		commit: string | null
	}
	targets: Array<ArtifactEvidenceTarget>
	page: {
		total: number
		offset: number
		limit: number
		returned: number
		nextCursor: string | null
		stateFingerprint: string
	}
}

export class PackageArtifactEvidenceCursorError extends Error {}

type TargetPlan = {
	key: string
	kind: BundleArtifactKind
	artifactName: string | null
	entryPoint: string | null
	declared: boolean
	row: PublishedBundleArtifactRecord | null
	jobs: Array<JobRecord>
}

async function sha256Hex(text: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	)
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

const serializedModuleFields = [
	'js',
	'cjs',
	'text',
	'dataBase64',
	'json',
] as const

/**
 * Canonical text for one stored (serialized) Worker Loader module. Hashes
 * cover module type and content so a js/text swap changes the hash; bytes
 * never leave this function.
 */
function canonicalModuleText(module: unknown): string | null {
	if (typeof module === 'string') return `string\u0000${module}`
	if (!module || typeof module !== 'object' || Array.isArray(module)) {
		return null
	}
	const record = module as Record<string, unknown>
	let text = ''
	let fields = 0
	for (const field of serializedModuleFields) {
		const value = record[field]
		if (value === undefined) continue
		if (field === 'json') {
			text += `json\u0000${JSON.stringify(value)}\u0000`
		} else if (typeof value === 'string') {
			text += `${field}\u0000${value}\u0000`
		} else {
			return null
		}
		fields += 1
	}
	return fields > 0 ? text : null
}

function safeCommit(value: unknown) {
	return typeof value === 'string' && commitShaPattern.test(value)
		? value
		: null
}

function identityKey(input: {
	kind: string
	artifactName: string | null
	entryPoint: string | null
}) {
	return `${input.kind}|${input.artifactName ?? ''}|${input.entryPoint ?? ''}`
}

function emptyEvidence(input: {
	commit: string | null
	kvKey: string | null
	kvKeyDerived: boolean
	status: ArtifactPayloadStatus
	malformedReason?: ArtifactPayloadEvidence['malformedReason']
	sizeBytes?: number | null
}): ArtifactPayloadEvidence {
	return {
		commit: input.commit,
		kvKey: input.kvKeyDerived ? input.kvKey : null,
		kvKeyDerived: input.kvKeyDerived,
		status: input.status,
		malformedReason: input.malformedReason ?? null,
		identityMismatchFields: [],
		embeddedCommit: null,
		embeddedCommitMatches: null,
		mainModule: null,
		mainModuleSha256: null,
		bundleSha256: null,
		moduleCount: null,
		modules: [],
		modulesTruncated: false,
		sizeBytes: input.sizeBytes ?? null,
	}
}

/**
 * Read one stored payload and describe it without deserializing or loading
 * its modules. Validation mirrors `readPublishedBundleArtifact` plus
 * `matchesPublishedBundleArtifactIdentity`, the checks runtime hydration
 * applies before using a payload.
 */
async function inspectPayload(input: {
	kv: KVNamespace | undefined
	kvKey: string
	kvKeyDerived: boolean
	sourceId: string
	commit: string
	kind: BundleArtifactKind
	artifactName: string | null
	entryPoint: string
}): Promise<ArtifactPayloadEvidence> {
	const base = {
		commit: input.commit,
		kvKey: input.kvKey,
		kvKeyDerived: input.kvKeyDerived,
	}
	if (!input.kv) return emptyEvidence({ ...base, status: 'kv_unavailable' })
	const raw = await input.kv.get(input.kvKey, 'text')
	if (raw == null) return emptyEvidence({ ...base, status: 'missing' })
	const sizeBytes = new TextEncoder().encode(raw).byteLength
	let stored: unknown
	try {
		stored = JSON.parse(raw)
	} catch {
		return emptyEvidence({
			...base,
			status: 'malformed',
			malformedReason: 'invalid_json',
			sizeBytes,
		})
	}
	if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
		return emptyEvidence({
			...base,
			status: 'malformed',
			malformedReason: 'not_object',
			sizeBytes,
		})
	}
	const artifact = stored as Record<string, unknown>
	if (!isUsableStoredPublishedBundleArtifact(artifact)) {
		return emptyEvidence({
			...base,
			status: 'malformed',
			malformedReason:
				typeof artifact.modules === 'object' && artifact.modules != null
					? 'unsupported_version'
					: 'invalid_modules',
			sizeBytes,
		})
	}
	const modules = artifact.modules as Record<string, unknown>
	const moduleHashes: Array<{ path: string; sha256: string }> = []
	for (const [path, module] of Object.entries(modules)) {
		const canonical = canonicalModuleText(module)
		if (canonical == null) {
			return emptyEvidence({
				...base,
				status: 'malformed',
				malformedReason: 'invalid_modules',
				sizeBytes,
			})
		}
		moduleHashes.push({ path, sha256: await sha256Hex(canonical) })
	}
	moduleHashes.sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	)
	const mainModule =
		typeof artifact.mainModule === 'string' ? artifact.mainModule : null
	const mainModuleSha256 =
		moduleHashes.find((entry) => entry.path === mainModule)?.sha256 ?? null
	const bundleSha256 = await sha256Hex(
		[
			`main\u0000${mainModule ?? ''}`,
			...moduleHashes.map((entry) => `${entry.path}\u0000${entry.sha256}`),
		].join('\n'),
	)
	let artifactEntryPoint: string | null = null
	try {
		artifactEntryPoint =
			typeof artifact.entryPoint === 'string'
				? normalizeEntryPoint(artifact.entryPoint)
				: null
	} catch {
		artifactEntryPoint = null
	}
	const mismatched: Array<string> = []
	if (artifact.sourceId !== input.sourceId) mismatched.push('sourceId')
	if (artifact.publishedCommit !== input.commit) {
		mismatched.push('publishedCommit')
	}
	if (artifact.kind !== input.kind) mismatched.push('kind')
	if (
		normalizeArtifactName(
			typeof artifact.artifactName === 'string' ? artifact.artifactName : null,
		) !== input.artifactName
	) {
		mismatched.push('artifactName')
	}
	if (artifactEntryPoint !== input.entryPoint) mismatched.push('entryPoint')
	if (mainModuleSha256 == null) mismatched.push('mainModule')
	const matches =
		mismatched.length === 0 &&
		matchesPublishedBundleArtifactIdentity({
			artifact: artifact as unknown as PublishedBundleArtifact,
			sourceId: input.sourceId,
			publishedCommit: input.commit,
			kind: input.kind,
			artifactName: input.artifactName,
			entryPoint: input.entryPoint,
		})
	const embeddedCommit = safeCommit(artifact.publishedCommit)
	return {
		...emptyEvidence({ ...base, status: 'valid', sizeBytes }),
		status: matches ? 'valid' : 'identity_mismatch',
		identityMismatchFields: matches
			? []
			: mismatched.length > 0
				? mismatched
				: ['identity'],
		embeddedCommit,
		embeddedCommitMatches: artifact.publishedCommit === input.commit,
		mainModule: mainModule && mainModule.length <= 512 ? mainModule : null,
		mainModuleSha256,
		bundleSha256,
		moduleCount: moduleHashes.length,
		modules: moduleHashes
			.slice(0, packageArtifactEvidenceModuleListLimit)
			.map((entry) => ({
				path:
					entry.path.length <= 512
						? entry.path
						: `${entry.path.slice(0, 509)}...`,
				sha256: entry.sha256,
			})),
		modulesTruncated:
			moduleHashes.length > packageArtifactEvidenceModuleListLimit,
	}
}

function derivedKvKey(input: {
	sourceId: string
	commit: string
	kind: BundleArtifactKind
	artifactName: string | null
	entryPoint: string
}) {
	return buildPublishedBundleArtifactKvKey({
		sourceId: input.sourceId,
		publishedCommit: input.commit,
		kind: input.kind,
		artifactName: input.artifactName,
		entryPoint: input.entryPoint,
	})
}

function parseCursor(cursor: string | null | undefined) {
	if (cursor == null) return { offset: 0, fingerprint: null }
	const match = /^(\d{1,6})\.([0-9a-f]{16})$/.exec(cursor)
	if (!match) {
		throw new PackageArtifactEvidenceCursorError('invalid_cursor')
	}
	return { offset: Number(match[1]), fingerprint: match[2] ?? null }
}

async function planTargets(input: {
	env: Env
	ownerId: string
	sourceId: string
	rows: Array<PublishedBundleArtifactRecord>
	jobs: Array<JobRecord>
	hasSource: boolean
}): Promise<{
	plans: Array<TargetPlan>
	manifest: PackageArtifactEvidence['manifest']
}> {
	let manifest: PackageArtifactEvidence['manifest'] = {
		status: 'unavailable',
		commit: null,
	}
	const plans: Array<TargetPlan> = []
	const byKey = new Map<string, TargetPlan>()
	const add = (plan: TargetPlan) => {
		if (byKey.has(plan.key)) return
		byKey.set(plan.key, plan)
		plans.push(plan)
	}
	if (input.hasSource) {
		try {
			const loaded = await loadServingPackageManifestBySourceId({
				env: input.env,
				baseUrl: 'https://kody.invalid',
				userId: input.ownerId,
				sourceId: input.sourceId,
			})
			manifest = {
				status: 'loaded',
				commit: safeCommit(loaded.source.published_commit),
			}
			for (const target of collectPublishedPackageArtifactTargets(
				loaded.manifest,
			)) {
				const artifactName = normalizeArtifactName(target.artifactName)
				const entryPoint = normalizeEntryPoint(target.entryPoint)
				add({
					key: identityKey({ kind: target.kind, artifactName, entryPoint }),
					kind: target.kind,
					artifactName,
					entryPoint,
					declared: true,
					row: null,
					jobs: [],
				})
			}
		} catch {
			manifest = { status: 'unavailable', commit: null }
		}
	}
	for (const row of input.rows) {
		if (!bundleArtifactKinds.has(row.artifactKind)) continue
		const key = identityKey({
			kind: row.artifactKind,
			artifactName: row.artifactName,
			entryPoint: row.entryPoint,
		})
		const existing = byKey.get(key)
		if (existing) {
			existing.row ??= row
			continue
		}
		add({
			key,
			kind: row.artifactKind as BundleArtifactKind,
			artifactName: row.artifactName,
			entryPoint: row.entryPoint,
			declared: false,
			row,
			jobs: [],
		})
	}
	for (const job of input.jobs) {
		const match = plans.find(
			(plan) => plan.kind === 'job' && plan.artifactName === job.name,
		)
		if (match) {
			match.jobs.push(job)
			continue
		}
		add({
			key: identityKey({
				kind: 'job',
				artifactName: job.name,
				entryPoint: null,
			}),
			kind: 'job',
			artifactName: job.name,
			entryPoint: null,
			declared: false,
			row: null,
			jobs: [job],
		})
	}
	return { plans, manifest }
}

async function inspectTarget(input: {
	env: Env
	sourceId: string
	servingCommit: string | null
	servingArtifactCommit: string | null
	plan: TargetPlan
}): Promise<ArtifactEvidenceTarget> {
	const { plan } = input
	const kv = (input.env as Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace })
		.BUNDLE_ARTIFACTS_KV
	const selector = runtimeSelectorForArtifactKind(plan.kind)
	const requestedCommit =
		selector === 'serving_commit'
			? input.servingCommit
			: input.servingArtifactCommit
	const row = plan.row
	const identity = {
		sourceId: input.sourceId,
		kind: plan.kind,
		artifactName: plan.artifactName,
	}
	let selected: ArtifactPayloadEvidence | null = null
	let newestRow: ArtifactEvidenceTarget['newestRow'] = null
	if (plan.entryPoint != null) {
		const entryPoint = plan.entryPoint
		const rowKeyDerived =
			row != null &&
			safeCommit(row.publishedCommit) != null &&
			row.kvKey ===
				derivedKvKey({ ...identity, entryPoint, commit: row.publishedCommit })
		// Mirrors hydratePublishedBundleArtifactRow: a different requested
		// commit reads the commit-keyed key; otherwise the row's own key.
		if (
			row &&
			(requestedCommit == null || requestedCommit === row.publishedCommit)
		) {
			selected = await inspectPayload({
				kv,
				kvKey: row.kvKey,
				kvKeyDerived: rowKeyDerived,
				...identity,
				entryPoint,
				commit: row.publishedCommit,
			})
		} else if (requestedCommit != null) {
			selected = await inspectPayload({
				kv,
				kvKey: derivedKvKey({
					...identity,
					entryPoint,
					commit: requestedCommit,
				}),
				kvKeyDerived: true,
				...identity,
				entryPoint,
				commit: requestedCommit,
			})
			if (row) {
				const { modules: _modules, ...rest } = await inspectPayload({
					kv,
					kvKey: row.kvKey,
					kvKeyDerived: rowKeyDerived,
					...identity,
					entryPoint,
					commit: row.publishedCommit,
				})
				newestRow = rest
			}
		}
	}
	return {
		key: plan.key,
		kind: plan.kind,
		artifactName: plan.artifactName,
		entryPoint: plan.entryPoint,
		declared: plan.declared,
		selector,
		identityRow: row
			? {
					builtFromCommit: safeCommit(row.publishedCommit) ?? 'invalid',
					builtFromCommitValid: safeCommit(row.publishedCommit) != null,
					updatedAt: row.updatedAt,
				}
			: null,
		selected,
		runtimeLoads: row != null && selected?.status === 'valid',
		newestRow,
		selectedMatchesNewestRowBytes:
			newestRow?.bundleSha256 && selected?.bundleSha256
				? newestRow.bundleSha256 === selected.bundleSha256
				: null,
		jobs: plan.jobs
			.map((job) => ({
				jobId: job.id,
				enabled: job.enabled,
				recordedCommit: job.publishedCommit,
			}))
			.sort((left, right) => left.jobId.localeCompare(right.jobId)),
	}
}

/**
 * Read-only evidence of which stored bundle bytes runtime readers select for
 * every declared target of a package. Reads D1 rows, the serving-commit
 * manifest, and KV payloads only: never loads, executes, compiles, or
 * rebuilds package code, and returns hashes and metadata, never bytes.
 */
export async function loadPackageArtifactEvidence(input: {
	env: Env
	target: PackageProvenanceTarget
	limit?: number
	cursor?: string | null
}): Promise<PackageArtifactEvidence | null> {
	const limit = Math.max(
		1,
		Math.min(
			input.limit ?? packageArtifactEvidenceDefaultLimit,
			packageArtifactEvidenceMaxLimit,
		),
	)
	const cursor = parseCursor(input.cursor)
	const db = input.env.APP_DB
	const pkg = await resolvePackageForProvenance(db, input.target)
	if (!pkg) return null
	const ownerId = pkg.userId
	const [source, rows, jobRows] = await Promise.all([
		getEntitySourceById(db, pkg.sourceId),
		listPublishedBundleArtifactsBySourceId(db, ownerId, pkg.sourceId),
		jobsData(input.env).listJobsForUser({ userId: ownerId }),
	])
	const liveSource = source && source.user_id === ownerId ? source : null
	const servingCommit = liveSource ? servingCommitForSource(liveSource) : null
	const servingArtifactCommit = liveSource
		? servingArtifactCommitForSource(liveSource)
		: null
	const jobs = jobRows
		.map((row) => row.record)
		.filter((record) => record.sourceId === pkg.sourceId)
		.sort((left, right) => left.id.localeCompare(right.id))
	const { plans, manifest } = await planTargets({
		env: input.env,
		ownerId,
		sourceId: pkg.sourceId,
		rows,
		jobs,
		hasSource: liveSource != null,
	})
	const stateFingerprint = (
		await sha256Hex(
			JSON.stringify([
				liveSource?.published_commit ?? null,
				liveSource?.serving_commit ?? null,
				manifest.status,
				plans.map((plan) => plan.key),
			]),
		)
	).slice(0, 16)
	if (cursor.fingerprint != null && cursor.fingerprint !== stateFingerprint) {
		throw new PackageArtifactEvidenceCursorError('cursor_state_changed')
	}
	const page = plans.slice(cursor.offset, cursor.offset + limit)
	const targets = await mapWithConcurrency(page, kvReadConcurrency, (plan) =>
		inspectTarget({
			env: input.env,
			sourceId: pkg.sourceId,
			servingCommit,
			servingArtifactCommit,
			plan,
		}),
	)
	const nextOffset = cursor.offset + page.length
	return {
		package: {
			packageId: pkg.id,
			name: pkg.name,
			ownerId,
			sourceId: pkg.sourceId,
		},
		source: liveSource
			? {
					publishedCommit: liveSource.published_commit,
					servingCommit,
					servingArtifactCommit,
				}
			: null,
		manifest,
		targets,
		page: {
			total: plans.length,
			offset: cursor.offset,
			limit,
			returned: targets.length,
			nextCursor:
				nextOffset < plans.length ? `${nextOffset}.${stateFingerprint}` : null,
			stateFingerprint,
		},
	}
}
