import { findFetchBodiesMissingSecretResolution } from '#worker/credentials/fetch-body-secret-resolution.ts'
import {
	adoptScannableModulePlan,
	planScannableModules,
	ScannableModuleAstLimitError,
	scannableModuleIndex,
	type ScannableModulePlan,
	shareModulePasses,
} from '#worker/credentials/module-placeholder-scan.ts'
import {
	secretPlaceholderRequestPlacementsOf,
	type SecretPlaceholderRequestPlacementHit,
} from '#worker/credentials/secret-placeholder-request-placement.ts'
import type { ResolvedSecretProviderSlots } from '#worker/credentials/secret-provider-slots.ts'
import {
	detectLegacyCredentialPatternsCodemod,
	detectLegacyCredentialPatternsCodemodId,
	type LegacyCredentialPattern,
	legacyCredentialPatternFromMessage,
} from '#worker/package-codemods/codemods/0010-detect-legacy-credential-patterns.ts'
import {
	collectCredentialStampPasses,
	collectServerRuntimeModulePaths,
	type CredentialStampPasses,
	credentialStampConversionFixGuidance,
	mergeCredentialStampIntoManifestFiles,
	mergeCredentialStampPasses,
	mergeLegacyCredentialFindings,
	omitOversizedCredentialStampModules,
	sealCredentialStamp,
} from '#worker/credentials/credential-stamp.ts'
import {
	mergePackageCredentialScans,
	scanPackageCredentials,
	type CredentialReference,
	type PackageCredentialScan,
} from '#worker/credentials/credential-inventory-scan.ts'
import {
	type PackageCredentialSlotKind,
	type PackageCredentialSlot,
	packageCredentialSlotKindValues,
} from '#worker/package-registry/types.ts'
import {
	readSecretMountAliases,
	secretMountsKeptCompatNote,
} from '#worker/package-runtime/secret-mount-compat.ts'
import { credentialScanSizeLimitMessage } from './isolated-runner-limit-message.ts'
import type { PackageCodemodFinding } from '#worker/package-codemods/types.ts'
import { normalizeRepoWorkspacePath } from './manifest.ts'

const credentialPatternCheckLabel = `codemod ${detectLegacyCredentialPatternsCodemodId}`
const credentialStampGateHeading =
	'Credential stamp publish gate (issue #3836 phase 1):'
const credentialStampGateFixIntro =
	'Publish failed. Packages must be conversion-ready: every credential use is a fixed kody.credentials slot with a real description, and every call site uses a literal key. Prefer credential("SLOT") / credentials("SLOT") so callers can pick which saved credential fills each slot with the execute credentials call map ({ "SLOT": "credential-name" }) or a stored/trigger mapping; placeholders and createAuthenticatedFetch resolve the literal slot name as a saved credential name. Never choose credential names at runtime, and do not use |scope=, packageSecrets.get, server eval, vault placeholders, or credential.named() in stamped packages. Leftover kody.secretMounts may stay so stale static dependents keep resolving; removing a mount or deleting its secret breaks those dependents. Fix each item below, then publish again.'
const credentialPatternFindingsHeading = `Credential placeholder references (${credentialPatternCheckLabel}):`
const credentialPatternLabelsDoc =
	'Labels are described under "Credential slots" in the packages docs.'

/**
 * Notes for labels whose requests need a change to work as written, or where
 * a more secure option already fits. Placeholders themselves keep working
 * (ADR 0068), so no note may read as a coming removal.
 */
const credentialPatternNotes: Partial<Record<LegacyCredentialPattern, string>> =
	{
		'plain http':
			'plain http: the fetch gateway refuses a request that carries a placeholder over http://; use https:// for those requests.',
	}

type CredentialTypeHint = 'inject' | 'oauth' | 'url' | 'login' | 'signing'

/**
 * Optional suggestions, one per credential type that fits a placement the
 * scan found (ADR 0068). They describe a choice, never a problem: nothing is
 * suggested for a placement no type fits, and placeholders keep working.
 */
const credentialTypeHints: Record<CredentialTypeHint, string> = {
	inject:
		"Header, query, or basic auth placeholders: a Key with an inject (credentialUpdate) can be opened with credential(key), and its client places the value and sends it only to the Key's hosts.",
	oauth:
		'Integration token headers: credential(key) for an OAuth connection sends Authorization: Bearer and refreshes the token for you.',
	url: 'Path or whole-URL placeholders: a url credential (secretSet kind "url") holds the whole URL, and its client fetches it without the URL entering code.',
	login:
		'Password or token exchange bodies: a login credential (secretSet kind "login") runs the exchange on the host and places the session token.',
	signing:
		'Signing (secretJwtSign or signature key material): a signing credential (secretSet kind "signing") signs through credential(key).sign() without exposing the key.',
}

const credentialTypeHintsHeading =
	'Optional, if you want a scoped credential type for these (ADR 0068):'

/**
 * Whole field names only. An unanchored `pass` also matches `compass`.
 * `refresh_token` / `client_secret` stay the same names, including camelCase.
 */
const loginBodyFieldPattern =
	/^(?:pass(?:word|wd)?|refresh_?token|client_?secret)$/i

/** Codemod 0010 lists a secret name unless this slot kind is declared for it. */
const declaredSlotKindByNameKind = {
	secret: 'secret',
	integration: 'oauth',
} as const satisfies Record<CredentialReference['nameKind'], 'secret' | 'oauth'>

const packageCredentialKinds: ReadonlySet<string> = new Set(
	packageCredentialSlotKindValues,
)

function credentialTypeHintFor(
	reference: CredentialReference,
): CredentialTypeHint | null {
	const { placement } = reference
	switch (placement.type) {
		case 'header':
			if (reference.nameKind === 'integration') {
				return placement.name === 'authorization' &&
					placement.format === 'Bearer {value}'
					? 'oauth'
					: null
			}
			return 'inject'
		case 'query':
			return reference.nameKind === 'integration' ? null : 'inject'
		case 'basic':
			return null
		case 'path':
		case 'url':
			return 'url'
		case 'body': {
			if (placement.endpoint !== 'login') return null
			const field = placement.field ?? reference.name
			return loginBodyFieldPattern.test(field) ? 'login' : null
		}
		case 'signing':
			return 'signing'
		case 'header-custom':
		case 'binding':
		case 'other':
			return null
		default: {
			const exhaustive: never = placement
			throw new Error(`Unhandled placement: ${String(exhaustive)}`)
		}
	}
}

function credentialTypeHintLines(
	sourceFiles: Record<string, string>,
	scan: Pick<
		PackageCredentialScan,
		'references' | 'jwtSignCalls' | 'jwtSignSecretNames'
	>,
) {
	const declaredKinds = declaredSlotKinds(
		Object.entries(
			readDeclaredCredentialSlots(sourceFiles['package.json']) ?? {},
		).map(([name, slot]) => ({
			name,
			...(slot.kind ? { kind: slot.kind } : {}),
		})),
	)
	const found = new Set<CredentialTypeHint>()
	for (const reference of scan.references) {
		if (referenceNamesDeclaredSlot(reference, declaredKinds)) continue
		const hint = credentialTypeHintFor(reference)
		if (hint) found.add(hint)
	}
	for (const name of scan.jwtSignSecretNames) {
		if (declaredKinds.get(name) === 'secret') continue
		found.add('signing')
		break
	}
	if (scan.jwtSignCalls > scan.jwtSignSecretNames.length) {
		found.add('signing')
	}
	const hints = (Object.keys(credentialTypeHints) as Array<CredentialTypeHint>)
		.filter((hint) => found.has(hint))
		.map((hint) => `- ${credentialTypeHints[hint]}`)
	return hints.length > 0 ? [credentialTypeHintsHeading, ...hints] : []
}

function declaredSlotKinds(
	slots: ReadonlyArray<{ name: string; kind?: PackageCredentialSlotKind }>,
) {
	const kinds = new Map<string, PackageCredentialSlotKind | null>()
	for (const slot of slots) {
		kinds.set(slot.name, slot.kind ?? null)
	}
	return kinds
}

function referenceNamesDeclaredSlot(
	reference: CredentialReference,
	declared: ReadonlyMap<string, PackageCredentialSlotKind | null>,
) {
	if (!declared.has(reference.name)) return false
	const kind = declared.get(reference.name)
	if (kind == null) return true
	return kind === declaredSlotKindByNameKind[reference.nameKind]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isPackageCredentialKind(
	value: string,
): value is PackageCredentialSlotKind {
	return packageCredentialKinds.has(value)
}

function readDeclaredCredentialSlots(
	manifestSource: string | undefined,
): Record<string, PackageCredentialSlot> | undefined {
	if (manifestSource == null) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestSource)
	} catch {
		return undefined
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.kody)) return undefined
	const credentials = parsed.kody.credentials
	if (!isPlainObject(credentials)) return undefined
	const slots: Record<string, PackageCredentialSlot> = {}
	for (const [name, slot] of Object.entries(credentials)) {
		const declared = credentialSlotFromManifest(slot)
		if (declared) slots[name] = declared
	}
	return Object.keys(slots).length > 0 ? slots : undefined
}

function credentialSlotFromManifest(
	slot: unknown,
): PackageCredentialSlot | null {
	if (!isPlainObject(slot)) return null
	const description =
		typeof slot.description === 'string' && slot.description.trim().length > 0
			? slot.description
			: null
	if (description == null) return null
	const declared: PackageCredentialSlot = { description }
	if (typeof slot.kind === 'string') {
		if (!isPackageCredentialKind(slot.kind)) return null
		declared.kind = slot.kind
	}
	if (typeof slot.provider === 'string' && slot.provider.trim().length > 0) {
		declared.provider = slot.provider
	}
	if (typeof slot.multiple === 'boolean') declared.multiple = slot.multiple
	return declared
}

export type CredentialPatternCheckResult = {
	kind: 'credentials'
	ok: boolean
	message: string
	/** Set when the isolated scan could not run (see RepoCheckResult). */
	failureOrigin?: 'platform'
	/** Manifest may gain auto-written stamp keys (never overwrites descriptions). */
	sourceFiles: Record<string, string>
	stampKeys: Array<string>
	/** Absent only from an isolated scan that hit its runner limit. */
	requestPlacementHits?: Array<SecretPlaceholderRequestPlacementHit>
	/** Fetch bodies the gateway would still scan. Absent like the hits above. */
	fetchBodyHits?: Array<{ path: string; line: number }>
}

/**
 * Most syntax nodes the credential scans walk for one publish. Their CPU
 * time grows with the node count. When every scan parsed and walked the tree
 * on its own, packages of 300,000 to 370,000 nodes (1.2 to 1.8 MiB of
 * modules) ran the isolated runner out of CPU time on some attempts. One
 * walk now serves the scans, which cut that cost by a third to a half.
 */
export const credentialScanMaxAstNodes = 450_000

const largestCredentialScanModulesShown = 5
const credentialScanTextEncoder = new TextEncoder()

/**
 * The failure message when the modules the credential scans walk hold more
 * than {@link credentialScanMaxAstNodes} syntax nodes, or null. Counting
 * stops at the limit, so an oversized tree is refused for the cost of one
 * partial parse instead of resetting the runner part way through the scans.
 */
async function credentialScanSizeLimitFailure(
	sourceFiles: Record<string, string>,
) {
	try {
		await scannableModuleIndex(sourceFiles, {
			maxAstNodes: credentialScanMaxAstNodes,
		})
		return null
	} catch (error) {
		if (!(error instanceof ScannableModuleAstLimitError)) throw error
		return credentialScanSizeLimitMessage({
			moduleCount: error.moduleCount,
			maxAstNodes: error.maxAstNodes,
			largest: [...error.modules]
				.sort((left, right) => right.astNodes - left.astNodes)
				.slice(0, largestCredentialScanModulesShown)
				.map(({ path }) => ({
					path,
					bytes: credentialScanTextEncoder.encode(sourceFiles[path]!)
						.byteLength,
				})),
		})
	}
}

/**
 * The modules one part of a credential scan reads: the walk's modules, plus
 * server-reachable modules the walk does not list (stamp view only).
 */
type CredentialTreeViewPlan = {
	modulePaths: Array<string>
	serverPaths: Array<string>
	/** Disjoint parts in sorted module order; never empty. */
	chunks: Array<ScannableModulePlan['visit']>
}

/**
 * How one tree is scanned. `stamp` is the tree without oversized modules,
 * which the stamp seals; `full` is set only when some were left out, for the
 * findings that cover every module.
 */
export type CredentialTreeScanPlan =
	| { sizeLimitMessage: string }
	| { stamp: CredentialTreeViewPlan; full: CredentialTreeViewPlan | null }

export type CredentialTreeChunkRequest = {
	view: 'stamp' | 'full'
	modulePaths: Array<string>
	serverPaths: Array<string>
	visit: ScannableModulePlan['visit']
	/** Also list the fetch bodies the gateway would still scan. */
	fetchBodies: boolean
	/** A package.json to scan in place of the tree's own. */
	manifest?: string
}

export type CredentialTreeChunk = {
	/** `stamp` view. */
	stamp: CredentialStampPasses | null
	/** `full` view. */
	full: {
		inventory: PackageCredentialScan
		legacyFindings: Array<PackageCodemodFinding>
	} | null
	fetchBodyHits: Array<{ path: string; line: number }>
}

/**
 * Where the module walks of a credential check run. The check plans the tree
 * once, then asks for each chunk of modules; the answers merge into the scan
 * of the whole tree. In process there is one chunk; publish checks of larger
 * trees give each chunk its own isolate so no walk nears the CPU limit.
 */
export type CredentialTreeScanner = {
	plan(): Promise<CredentialTreeScanPlan>
	/** Results in `requests` order. */
	chunks(
		requests: ReadonlyArray<CredentialTreeChunkRequest>,
	): Promise<Array<CredentialTreeChunk>>
}

/** A rough node count for a module the index did not parse. */
const sourceCharactersPerAstNode = 4

async function planCredentialTreeView(
	files: Record<string, string>,
	serverPaths: ReadonlyArray<string>,
	maxChunkAstNodes: number,
): Promise<CredentialTreeViewPlan> {
	const plan = await planScannableModules(files)
	const listed = new Set(plan.modulePaths)
	const units = [
		...plan.visit,
		...serverPaths
			.filter((path) => !listed.has(path) && files[path] != null)
			.map((path) => ({
				path,
				astNodes: Math.ceil(files[path]!.length / sourceCharactersPerAstNode),
				constants: [],
			})),
	].sort((left, right) =>
		left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
	)
	const chunks: Array<ScannableModulePlan['visit']> = [[]]
	let chunkAstNodes = 0
	for (const unit of units) {
		const chunk = chunks.at(-1)!
		if (chunk.length > 0 && chunkAstNodes + unit.astNodes > maxChunkAstNodes) {
			chunks.push([unit])
			chunkAstNodes = unit.astNodes
		} else {
			chunk.push(unit)
			chunkAstNodes += unit.astNodes
		}
	}
	return {
		modulePaths: plan.modulePaths,
		serverPaths: [...serverPaths],
		chunks,
	}
}

/**
 * Plan the credential scan of `files`: refuse an oversized tree, else split
 * its modules into chunks of at most `maxChunkAstNodes` syntax nodes (one
 * module larger than that is a chunk of its own).
 */
export async function planCredentialTreeScan(
	files: Record<string, string>,
	maxChunkAstNodes = Number.POSITIVE_INFINITY,
): Promise<CredentialTreeScanPlan> {
	const sizeLimitMessage = await credentialScanSizeLimitFailure(files)
	if (sizeLimitMessage) return { sizeLimitMessage }
	const stampFiles = omitOversizedCredentialStampModules(files)
	return {
		stamp: await planCredentialTreeView(
			stampFiles,
			[...(await collectServerRuntimeModulePaths(stampFiles))].sort(),
			maxChunkAstNodes,
		),
		// The stamp scan left oversized modules out, so the findings that
		// cover every module need their own walk of the full tree.
		full:
			stampFiles === files
				? null
				: await planCredentialTreeView(files, [], maxChunkAstNodes),
	}
}

/** Walk one chunk of a planned credential scan of `files`. */
export async function scanCredentialTreeChunk(
	files: Record<string, string>,
	request: CredentialTreeChunkRequest,
): Promise<CredentialTreeChunk> {
	const tree =
		request.manifest == null
			? files
			: { ...files, 'package.json': request.manifest }
	const viewFiles =
		request.view === 'stamp' ? omitOversizedCredentialStampModules(tree) : tree
	adoptScannableModulePlan(viewFiles, {
		modulePaths: request.modulePaths,
		visit: request.visit,
	})
	const fetchBodyHits: CredentialTreeChunk['fetchBodyHits'] = []
	if (request.fetchBodies) {
		const listed = new Set(request.modulePaths)
		for (const { path } of request.visit) {
			const source = viewFiles[path]
			if (!listed.has(path) || typeof source !== 'string') continue
			for (const hit of findFetchBodiesMissingSecretResolution(source)) {
				fetchBodyHits.push({ path, line: hit.line })
			}
		}
	}
	if (request.view === 'stamp') {
		return {
			stamp: await collectCredentialStampPasses(
				viewFiles,
				new Set(request.serverPaths),
			),
			full: null,
			fetchBodyHits,
		}
	}
	const [inventory, legacyFindings] = await shareModulePasses(viewFiles, [
		() =>
			scanPackageCredentials({
				files: viewFiles,
				slots: undefined,
				sites: true,
			}),
		() =>
			detectLegacyCredentialPatternsCodemod.detect(viewFiles, {
				packageName: readPackageName(viewFiles),
			}),
	])
	return { stamp: null, full: { inventory, legacyFindings }, fetchBodyHits }
}

function inProcessCredentialTreeScanner(
	files: Record<string, string>,
): CredentialTreeScanner {
	return {
		plan: () => planCredentialTreeScan(files),
		async chunks(requests) {
			const results: Array<CredentialTreeChunk> = []
			for (const request of requests) {
				results.push(await scanCredentialTreeChunk(files, request))
			}
			return results
		},
	}
}

function requireChunkPart<Part>(part: Part | null): Part {
	if (part == null) {
		throw new Error('Credential scan chunk did not answer the view asked for.')
	}
	return part
}

/**
 * Credential stamp publish gate: fail closed on non-literal / unstampable
 * credential patterns and on eval / new Function / non-literal import() in
 * server-runtime entry graphs. Auto-writes missing `kody.credentials` keys
 * from the stamp and fails when any stamped key lacks a description.
 */
export async function buildCredentialPatternCheck(
	sourceFiles: Record<string, string>,
	options: {
		secretProviders?: ResolvedSecretProviderSlots
		/** Defaults to walking every module in this process. */
		scanner?: CredentialTreeScanner
	} = {},
): Promise<CredentialPatternCheckResult> {
	const scanner = options.scanner ?? inProcessCredentialTreeScanner(sourceFiles)
	const plan = await scanner.plan()
	if ('sizeLimitMessage' in plan) {
		return {
			kind: 'credentials',
			ok: false,
			message: plan.sizeLimitMessage,
			sourceFiles,
			stampKeys: [],
		}
	}
	const scanView = (
		view: CredentialTreeChunkRequest['view'],
		viewPlan: CredentialTreeViewPlan,
		manifest: string | undefined,
	) =>
		scanner.chunks(
			viewPlan.chunks.map((visit) => ({
				view,
				modulePaths: viewPlan.modulePaths,
				serverPaths: viewPlan.serverPaths,
				visit,
				fetchBodies: view === 'full' || plan.full == null,
				...(manifest == null ? {} : { manifest }),
			})),
		)
	/** `manifest` is set when `files` differs from the planned tree by it. */
	const scanTree = async (files: Record<string, string>, manifest?: string) => {
		const stampChunks = await scanView('stamp', plan.stamp, manifest)
		const stamp = sealCredentialStamp(
			files['package.json'],
			mergeCredentialStampPasses(
				stampChunks.map((chunk) => requireChunkPart(chunk.stamp)),
			),
			options.secretProviders
				? { secretProviders: options.secretProviders }
				: {},
		)
		// The stamp walk already covers every module for these, unless it left
		// oversized modules out. Then the full view's walk covers the tree.
		const fullChunks = plan.full
			? await scanView('full', plan.full, manifest)
			: null
		const fullParts = fullChunks?.map((chunk) => requireChunkPart(chunk.full))
		const inventory = fullParts
			? mergePackageCredentialScans(fullParts.map((part) => part.inventory))
			: stamp.scan
		const legacyFindings = fullParts
			? mergeLegacyCredentialFindings(
					fullParts.map((part) => part.legacyFindings),
				)
			: stamp.legacyFindings
		const moduleOrder = new Map(
			(plan.full ?? plan.stamp).modulePaths.map((path, index) => [path, index]),
		)
		return {
			stamp,
			legacyFindings,
			typeHintLines: credentialTypeHintLines(files, inventory),
			requestPlacementHits: secretPlaceholderRequestPlacementsOf(inventory),
			// Chunks answer in sorted module order; the notice lists modules
			// in walk order. The sort is stable, so lines keep their order.
			fetchBodyHits: (fullChunks ?? stampChunks)
				.flatMap((chunk) => chunk.fetchBodyHits)
				.sort(
					(left, right) =>
						(moduleOrder.get(left.path) ?? 0) -
						(moduleOrder.get(right.path) ?? 0),
				),
		}
	}
	const preliminary = await scanTree(sourceFiles)
	const merged = mergeCredentialStampIntoManifestFiles(
		sourceFiles,
		preliminary.stamp.keys,
	)
	// Merge only rewrites package.json when it adds missing stamp keys, so
	// the first scan stands whenever the file set is unchanged.
	const {
		stamp,
		legacyFindings,
		typeHintLines,
		requestPlacementHits,
		fetchBodyHits,
	} =
		merged.addedKeys.length === 0
			? preliminary
			: await scanTree(merged.files, merged.files['package.json'])
	const patternsByPath = new Map<string, Array<string>>()
	for (const finding of legacyFindings) {
		const pattern = legacyCredentialPatternFromMessage(finding.message)
		if (pattern == null) continue
		const path = finding.path ?? 'package'
		patternsByPath.set(path, [...(patternsByPath.get(path) ?? []), pattern])
	}

	const mountNote = secretMountCompatLine(merged.files)
	if (stamp.failures.length > 0) {
		const failureLines = stamp.failures.map((failure) => `- ${failure.message}`)
		const staleNote =
			stamp.staleManifestKeys.length > 0
				? [
						`Stale kody.credentials keys with no stamped use (runtime will ignore them after phase 3): ${stamp.staleManifestKeys.join(', ')}.`,
					]
				: []
		const addedNote =
			merged.addedKeys.length > 0
				? [
						`Missing kody.credentials keys (add these with a real description; publish seals them into the stamp and never overwrites a description you already wrote): ${merged.addedKeys.join(', ')}.`,
					]
				: []
		return {
			kind: 'credentials',
			ok: false,
			message: [
				credentialStampGateHeading,
				credentialStampGateFixIntro,
				...failureLines,
				...addedNote,
				...staleNote,
				...(mountNote ? [mountNote] : []),
				credentialStampConversionFixGuidance,
				...typeHintLines,
			].join('\n'),
			sourceFiles: merged.files,
			stampKeys: stamp.keys,
			requestPlacementHits,
			fetchBodyHits,
		}
	}

	const staleNote =
		stamp.staleManifestKeys.length > 0
			? [
					`Stale kody.credentials keys with no stamped use: ${stamp.staleManifestKeys.join(', ')}. Remove them when you no longer need the descriptions, or keep them; runtime will allow only stamped keys after phase 3.`,
				]
			: []

	if (patternsByPath.size === 0 && stamp.keys.length === 0) {
		return {
			kind: 'credentials',
			ok: true,
			message: [
				credentialStampGateHeading,
				`Credential stamp is empty (${credentialPatternCheckLabel}): no literal credential uses to seal.`,
				...staleNote,
			]
				.filter(Boolean)
				.join('\n'),
			sourceFiles: merged.files,
			stampKeys: stamp.keys,
			requestPlacementHits,
			fetchBodyHits,
		}
	}

	const lines = [...patternsByPath].map(
		([path, patterns]) => `- ${path}: ${patterns.join(', ')}`,
	)
	const foundPatterns = new Set([...patternsByPath.values()].flat())
	const notes = Object.entries(credentialPatternNotes)
		.filter(([pattern]) => foundPatterns.has(pattern))
		.map(([, note]) => note)
	const stampLine =
		stamp.keys.length > 0
			? `Credential stamp keys (sorted): ${stamp.keys.join(', ')}.`
			: 'Credential stamp keys: (none).'
	return {
		kind: 'credentials',
		ok: true,
		message: [
			credentialStampGateHeading,
			stampLine,
			...(lines.length > 0
				? [
						credentialPatternFindingsHeading,
						...lines,
						`Remaining listed references are stampable literals or notes. ${credentialPatternLabelsDoc}`,
						...notes,
					]
				: []),
			...staleNote,
			...(mountNote ? [mountNote] : []),
			...typeHintLines,
		]
			.filter((line): line is string => line != null && line.length > 0)
			.join('\n'),
		sourceFiles: merged.files,
		stampKeys: stamp.keys,
		requestPlacementHits,
		fetchBodyHits,
	}
}

function secretMountCompatLine(sourceFiles: Record<string, string>) {
	const aliases = readSecretMountAliases(sourceFiles['package.json'])
	if (aliases == null) return null
	return secretMountsKeptCompatNote(aliases)
}

function readPackageName(sourceFiles: Record<string, string>) {
	try {
		const name: unknown = JSON.parse(sourceFiles['package.json'] ?? '').name
		return typeof name === 'string' ? name : ''
	} catch {
		return ''
	}
}

/**
 * The findings for a published file set, or null when there are none. Repo
 * paths are scoped to `sourceRoot` the way `runRepoChecks` reads them.
 */
export async function credentialPatternNoticeForFiles(
	files: Record<string, string>,
	sourceRoot = '',
) {
	const root = normalizeRepoWorkspacePath(sourceRoot).replace(/\/+$/, '')
	const scoped = root
		? Object.fromEntries(
				Object.entries(files)
					.filter(([path]) => path.startsWith(`${root}/`))
					.map(([path, content]) => [path.slice(root.length + 1), content]),
			)
		: files
	return credentialPatternFindingsNotice([
		await buildCredentialPatternCheck(scoped),
	])
}

/** The credentials check message when it found something, for publish output. */
export function credentialPatternFindingsNotice(
	results: ReadonlyArray<{
		kind: string
		message: string
		ok?: boolean
	}> | null,
) {
	const check = results?.find((result) => result.kind === 'credentials')
	if (check == null) return null
	if (check.ok === false) return check.message
	return check.message.startsWith(credentialStampGateHeading) ||
		check.message.startsWith(credentialPatternFindingsHeading)
		? check.message
		: null
}
