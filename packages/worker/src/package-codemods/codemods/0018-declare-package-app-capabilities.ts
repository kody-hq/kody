import {
	listScannableModulePaths,
	parseModule,
} from '#worker/credentials/module-placeholder-scan.ts'
import {
	type PackageAppCapabilityHostFacts,
	type PackageCodemod,
	type PackageCodemodContext,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'
import {
	collectModuleKodyCalls,
	needsCapabilityDeclaration,
	packageAppVisitorAuthorityPatternMessages,
	readPackageAppManifest,
} from './0017-detect-package-app-visitor-authority.ts'

export const declarePackageAppCapabilitiesCodemodId =
	'0018-declare-package-app-capabilities'

const packageManifestPath = 'package.json'

/**
 * Fixed messages only: findings reach the fleet operator, so they never
 * carry a capability name or file contents. The names live in `ownerDetail`.
 */
export const declarePackageAppCapabilitiesMessages = {
	declare:
		'declare capabilities: kody.app.capabilities is missing capabilities the app calls directly or through packages it imports. The fix adds them so the calls run as the publisher.',
	computed: packageAppVisitorAuthorityPatternMessages['computed capability'],
	mcp: packageAppVisitorAuthorityPatternMessages['kody.mcp'],
	unresolvedImport:
		'unresolved import: a kody package the app imports could not be followed, so the capabilities it calls are unknown.',
	unknownCapability:
		'unknown capability: the app calls a kody member that is not a platform capability. Nothing was added for it.',
	credentialNamed:
		'credential.named: the runtime refused a credential.named call. No capability entry covers it; declare the credential need instead.',
} as const

/** Counts of calls the fix cannot resolve statically, even with the logs. */
export type DeclarePackageAppCapabilitiesUnresolved = {
	computedCalls: number
	mcpCalls: number
	unresolvedImports: number
	unknownCapabilityNames: number
	credentialNamedCalls: number
}

/** Private to the owner (run item `ownerDetail`); never in findings. */
export type DeclarePackageAppCapabilitiesOwnerDetail = {
	addedCapabilities: Array<string>
	/** How many added names each source found (a name can come from several). */
	sources: { direct: number; importClosure: number; observed: number }
	unresolved: DeclarePackageAppCapabilitiesUnresolved
}

const emptyFacts: PackageAppCapabilityHostFacts = {
	closure: { names: [], computedCalls: 0, mcpCalls: 0, unresolvedImports: 0 },
	observed: { names: [], credentialNamedCalls: 0 },
	platformCapabilityNames: [],
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function detectJsonIndent(source: string) {
	const match = source.match(/\n([ \t]+)"/)
	return match?.[1] ?? '\t'
}

type Plan = {
	source: string
	manifest: Record<string, unknown>
	detail: DeclarePackageAppCapabilitiesOwnerDetail
	manual: Array<PackageCodemodFinding>
}

function planDeclarations(
	files: Record<string, string>,
	context: PackageCodemodContext,
): Plan | null {
	const source = Object.hasOwn(files, packageManifestPath)
		? files[packageManifestPath]
		: undefined
	const app = readPackageAppManifest(source)
	if (!app || source == null) return null
	const manifest = JSON.parse(source) as Record<string, unknown>
	const facts = context.packageAppCapabilities ?? emptyFacts
	const platform = new Set(facts.platformCapabilityNames)

	const direct = new Set<string>()
	let computedCalls = facts.closure.computedCalls
	let mcpCalls = facts.closure.mcpCalls
	let unresolvedImports = facts.closure.unresolvedImports
	for (const path of listScannableModulePaths(files)) {
		const parsed = parseModule(files[path]!)
		if (!parsed) {
			unresolvedImports += 1
			continue
		}
		const calls = collectModuleKodyCalls(parsed)
		for (const name of calls.names) direct.add(name)
		computedCalls += calls.computedCalls
		mcpCalls += calls.mcpCalls
	}
	const sources = [
		['direct', direct],
		['importClosure', new Set(facts.closure.names)],
		['observed', new Set(facts.observed.names)],
	] as const
	const wanted = new Set<string>()
	for (const [, names] of sources) {
		for (const name of names) {
			if (needsCapabilityDeclaration(name) && !app.capabilities.has(name)) {
				wanted.add(name)
			}
		}
	}
	const added = [...wanted].filter((name) => platform.has(name)).sort()
	const unknownCapabilityNames = wanted.size - added.length
	const addedSet = new Set(added)
	const countFrom = (names: ReadonlySet<string>) =>
		[...names].filter((name) => addedSet.has(name)).length
	const detail: DeclarePackageAppCapabilitiesOwnerDetail = {
		addedCapabilities: added,
		sources: {
			direct: countFrom(sources[0][1]),
			importClosure: countFrom(sources[1][1]),
			observed: countFrom(sources[2][1]),
		},
		unresolved: {
			computedCalls,
			mcpCalls,
			unresolvedImports,
			unknownCapabilityNames,
			credentialNamedCalls: facts.observed.credentialNamedCalls,
		},
	}
	const messages = declarePackageAppCapabilitiesMessages
	const manual: Array<PackageCodemodFinding> = []
	const note = (count: number, message: string) => {
		if (count > 0) manual.push({ path: null, message })
	}
	note(computedCalls, messages.computed)
	note(mcpCalls, messages.mcp)
	note(unresolvedImports, messages.unresolvedImport)
	note(unknownCapabilityNames, messages.unknownCapability)
	note(facts.observed.credentialNamedCalls, messages.credentialNamed)
	return { source, manifest, detail, manual }
}

function hasUnresolved(detail: DeclarePackageAppCapabilitiesOwnerDetail) {
	return Object.values(detail.unresolved).some((count) => count > 0)
}

function detectDeclarePackageAppCapabilities(
	files: Record<string, string>,
	context: PackageCodemodContext,
): Array<PackageCodemodFinding> {
	const plan = planDeclarations(files, context)
	if (!plan) return []
	return [
		...(plan.detail.addedCapabilities.length > 0
			? [
					{
						path: packageManifestPath,
						message: declarePackageAppCapabilitiesMessages.declare,
					},
				]
			: []),
		...plan.manual,
	]
}

function transformDeclarePackageAppCapabilities(
	files: Record<string, string>,
	context: PackageCodemodContext,
): PackageCodemodTransformResult {
	const plan = planDeclarations(files, context)
	if (!plan) {
		return { files, changed: false, changedPaths: [], needsManual: [] }
	}
	const ownerDetail =
		plan.detail.addedCapabilities.length > 0 || hasUnresolved(plan.detail)
			? { ownerDetail: plan.detail }
			: {}
	if (plan.detail.addedCapabilities.length === 0) {
		return {
			files,
			changed: false,
			changedPaths: [],
			needsManual: plan.manual,
			...ownerDetail,
		}
	}
	const kody = plan.manifest.kody as Record<string, unknown>
	const app = kody.app as Record<string, unknown>
	const existing = Array.isArray(app.capabilities)
		? app.capabilities.filter(
				(name): name is string => typeof name === 'string',
			)
		: []
	const capabilities = [...existing, ...plan.detail.addedCapabilities]
	const nextSource = `${JSON.stringify(
		{ ...plan.manifest, kody: { ...kody, app: { ...app, capabilities } } },
		null,
		detectJsonIndent(plan.source),
	)}\n`
	return {
		files: { ...files, [packageManifestPath]: nextSource },
		changed: true,
		changedPaths: [packageManifestPath],
		needsManual: plan.manual,
		...ownerDetail,
	}
}

export function isDeclarePackageAppCapabilitiesOwnerDetail(
	value: unknown,
): value is DeclarePackageAppCapabilitiesOwnerDetail {
	return (
		isPlainObject(value) &&
		Array.isArray(value.addedCapabilities) &&
		isPlainObject(value.sources) &&
		isPlainObject(value.unresolved)
	)
}

/**
 * One-time Phase 1 migration (ADR 0068, apps run as their publisher): add to
 * a published app's `kody.app.capabilities` every platform capability it
 * calls by a static name, directly or through the packages it imports, plus
 * the names the runtime authority logs saw it call undeclared. Republishes
 * the published tree even when the default branch drifted.
 */
export const declarePackageAppCapabilitiesCodemod: PackageCodemod = {
	id: declarePackageAppCapabilitiesCodemodId,
	description:
		'Add to kody.app.capabilities every platform capability a package app calls by name, directly or through packages it imports, plus the undeclared calls the runtime logged for it, so those calls run as the publisher instead of leaning on the visitor fallback.',
	applyMode: 'published-only',
	hostFacts: ['package-app-capabilities'],
	detect: detectDeclarePackageAppCapabilities,
	transform: transformDeclarePackageAppCapabilities,
}
