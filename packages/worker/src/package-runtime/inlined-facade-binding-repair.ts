import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'

/**
 * Published bundles inline each package's `kody:runtime` facade (only the
 * shared runtime module stays external). Facades built before
 * `createAuthenticatedFetch` and `oauthClientCredentials` joined
 * `packageBoundRuntimeExports` take those two straight from the shared
 * runtime, so package code calls the run's own helper and acts as the caller
 * (an integration locked to the package refuses it as "execute").
 *
 * This read-time repair binds them the way the current builder does: inside
 * each inlined facade section it adds
 * `var <local> = __kodyCreatePackageBound...(<id>)` and points the facade's
 * named and default exports at it. The id is the one the facade already
 * binds its storage, secrets, and credentials (and, after GHSA-5fv3, `kody`
 * and `fetch`) to, and it must be bundler provenance for the artifact, so
 * the bound helper only reaches authority that facade already holds.
 * Current bundles have nothing to rewrite.
 *
 * Facades come in two stored shapes, and both are repaired:
 * - named: `export { ... } from` the shared runtime (Sep 23, 2026 on). The
 *   bundle keeps the shared import line, the base default import, and the
 *   first bound export. Bundles from before GHSA-5fv3 bind only storage,
 *   secrets, and credentials there; later ones start with `fetch` and `kody`.
 * - star: `export * from` the shared runtime (before Sep 23, 2026). esbuild
 *   turns the facade into an `__export` namespace object that re-exports the
 *   shared runtime namespace, and package code reads helpers off it.
 */

type RepairableArtifact = {
	modules: WorkerLoaderModules
	dependencies: Array<{ packageId?: string }>
	packageContext: { packageId: string } | null
}

const identifierSource = String.raw`[A-Za-z_$][\w$]*`
const runtimeSpecifierSource = String.raw`("[^"\n]*\.__kody_virtual__\/runtime\.js")`
const baseDefaultImportSource = (specifierGroup: number) =>
	String.raw`import\s+__kodyBaseRuntimeDefault\d*\s*,\s*\{([^}]*)\}\s*from\s*` +
	`\\${specifierGroup}` +
	String.raw`;?[ \t]*\n`
const firstBoundExportSource = String.raw`var ${identifierSource} = __kodyCreatePackageBound[A-Za-z]+\d*\(("[^"\n]*")\);`

/**
 * Head of a named facade as esbuild keeps it: the shared-runtime re-export
 * import, the base default import from the same module, then the first
 * export bound to the package id. Matching the whole head (not a banner
 * comment) also finds facades of packages inlined from another package's
 * published bundle.
 */
const namedFacadeHeadPattern = new RegExp(
	[
		String.raw`^import\s*\{([^}]*)\}\s*from\s*${runtimeSpecifierSource};?[ \t]*\n`,
		baseDefaultImportSource(2),
		firstBoundExportSource,
	].join(''),
	'gm',
)

/**
 * Head of a star facade as esbuild emits it: the namespace object with the
 * facade's own exports, the re-export of the shared runtime namespace, that
 * namespace import, the base default import, then the first bound export.
 */
const starFacadeHeadPattern = new RegExp(
	[
		String.raw`^var (${identifierSource}) = \{\};[ \t]*\n`,
		String.raw`__export\(\1, \{\n([^}]*)\n\}\);[ \t]*\n`,
		String.raw`__reExport\(\1, (${identifierSource})(?:, ${identifierSource})?\);[ \t]*\n`,
		String.raw`import \* as \3 from ${runtimeSpecifierSource};[ \t]*\n`,
		baseDefaultImportSource(4),
		firstBoundExportSource,
	].join(''),
	'gm',
)

const facadeEndPattern = /^var KodyRuntime\d* = /m
const boundDefaultEntriesPattern = /Object\.entries\(\{([^}]*)\}\)/
/** The default export proxy's `get(target, property, receiver) {` line. */
const proxyGetHeadPattern = new RegExp(
	String.raw`get\(${identifierSource}, (${identifierSource}), ${identifierSource}\) \{[ \t]*\n`,
)
const boundCreatorCallPattern =
	/__kodyCreatePackageBound[A-Za-z]+\d*\(("[^"\n]*")\)/g
const boundCreatorNamePattern = /^__kodyCreatePackageBound[A-Za-z]+$/

/** Shared-runtime imports a facade must bind, and the creator for each. */
const facadeRepairCreators: Record<string, string> = {
	createAuthenticatedFetch: '__kodyCreatePackageBoundAuthenticatedFetch',
	oauthClientCredentials: '__kodyCreatePackageBoundOauthClientCredentials',
}

function moduleSource(module: WorkerLoaderModules[string]) {
	if (typeof module === 'string') return module
	if (module && typeof module === 'object' && typeof module.js === 'string') {
		return module.js
	}
	return null
}

function withModuleSource(
	module: WorkerLoaderModules[string],
	source: string,
): WorkerLoaderModules[string] {
	if (typeof module === 'string') return source
	return { ...module, js: source }
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseImportEntries(list: string) {
	return list
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(
				entry,
			)
			return match
				? { entry, imported: match[1]!, local: match[2] ?? match[1]! }
				: null
		})
}

function createNameAllocator(source: string) {
	const used = new Set<string>()
	return (base: string) => {
		for (let suffix = 0; ; suffix += 1) {
			const candidate = suffix === 0 ? base : `${base}${suffix}`
			if (used.has(candidate)) continue
			if (new RegExp(`\\b${escapeRegExp(candidate)}\\b`).test(source)) continue
			used.add(candidate)
			return candidate
		}
	}
}

type FacadeRepair = {
	/** Replacement for the matched head. */
	head: string
	/** Rewrite of the facade body (head end to the end marker). */
	patchBody: (body: string) => string
}

type FacadeRepairInput = {
	match: RegExpMatchArray
	packageId: string
	allocate: (base: string) => string
}

type FacadeMatch = {
	match: RegExpMatchArray
	repair: (input: FacadeRepairInput) => FacadeRepair | null
	/** The package id literal the facade's first bound export names. */
	idLiteral: string
	/** Names imported next to the base runtime default. */
	creatorList: string
}

/** Creator imports and `var` bindings for the helpers a facade must bind. */
function createBoundHelpers(input: {
	names: Array<{ imported: string; local: string }>
	specifier: string
	packageId: string
	allocate: (base: string) => string
}) {
	const id = JSON.stringify(input.packageId)
	const creatorImports: Array<string> = []
	const bindings: Array<string> = []
	for (const name of input.names) {
		const creator = facadeRepairCreators[name.imported]!
		const alias = input.allocate(creator)
		creatorImports.push(alias === creator ? creator : `${creator} as ${alias}`)
		bindings.push(`var ${name.local} = ${alias}(${id});`)
	}
	return {
		creatorImport: `import { ${creatorImports.join(', ')} } from ${input.specifier};`,
		bindings: bindings.join('\n'),
	}
}

/**
 * Named facade: drop the helpers from the shared import, bind them after the
 * head, and add them to the default export's bound entries.
 */
function repairNamedFacade(input: FacadeRepairInput): FacadeRepair | null {
	const [head, importList, specifier] = input.match
	const entries = parseImportEntries(importList!)
	if (entries.some((entry) => entry == null)) return null
	const parsed = entries.filter((entry) => entry != null)
	const targets = parsed.filter((entry) =>
		Object.hasOwn(facadeRepairCreators, entry.imported),
	)
	if (targets.length === 0) return null
	const kept = parsed.filter((entry) => !targets.includes(entry))
	const helpers = createBoundHelpers({
		names: targets,
		specifier: specifier!,
		packageId: input.packageId,
		allocate: input.allocate,
	})
	const imports = [
		...(kept.length > 0
			? [
					`import { ${kept.map((entry) => entry.entry).join(', ')} } from ${specifier};`,
				]
			: []),
		helpers.creatorImport,
	].join('\n')
	// Shared import first, then the rest of the head (base default import and
	// the first bound export), then the bound helpers.
	const restOfHead = head.slice(head.indexOf('\n') + 1)
	const defaultEntries = targets
		.map((target) => `${target.imported}: ${target.local}`)
		.join(', ')
	return {
		head: `${imports}\n${restOfHead}\n${helpers.bindings}`,
		patchBody: (body) =>
			body.replace(
				boundDefaultEntriesPattern,
				(_whole, entriesBody: string) =>
					`Object.entries({${entriesBody.trimEnd()}, ${defaultEntries} })`,
			),
	}
}

/**
 * Star facade: give the namespace object its own getters for the helpers
 * (esbuild's `__reExport` skips names the object already has), bind them
 * after the head, and answer them from the default export's proxy.
 */
function repairStarFacade(input: FacadeRepairInput): FacadeRepair | null {
	const [head, exportsName, exportEntries, , specifier] = input.match
	const ownNames = new Set(
		[...exportEntries!.matchAll(/^\s*([A-Za-z_$][\w$]*):/gm)].map(
			(entry) => entry[1]!,
		),
	)
	const targets = Object.keys(facadeRepairCreators)
		.filter((name) => !ownNames.has(name))
		.map((name) => ({ imported: name, local: input.allocate(name) }))
	if (targets.length === 0) return null
	const helpers = createBoundHelpers({
		names: targets,
		specifier: specifier!,
		packageId: input.packageId,
		allocate: input.allocate,
	})
	const exportsHead = `var ${exportsName} = {};\n__export(${exportsName}, {\n${exportEntries!.trimEnd()},\n${targets
		.map((target) => `  ${target.imported}: () => ${target.local}`)
		.join(',\n')}\n});\n`
	const restOfHead = head.slice(head.indexOf('__reExport('))
	return {
		head: `${exportsHead}${restOfHead}\n${helpers.creatorImport}\n${helpers.bindings}`,
		patchBody: (body) =>
			body.replace(
				proxyGetHeadPattern,
				(whole, property: string) =>
					`${whole}${targets
						.map(
							(target) =>
								`    if (${property} === ${JSON.stringify(target.imported)} && ${target.local} !== void 0) return ${target.local};\n`,
						)
						.join('')}`,
			),
	}
}

function parseStringLiteral(literal: string) {
	try {
		const value: unknown = JSON.parse(literal)
		return typeof value === 'string' ? value : null
	} catch {
		return null
	}
}

/** Every bound creator in the facade names the same package. */
function bindsOnlyPackage(text: string, idLiteral: string) {
	for (const call of text.matchAll(boundCreatorCallPattern)) {
		if (call[1] !== idLiteral) return false
	}
	return true
}

/** The base default import names only bound creators (a real facade). */
function importsOnlyBoundCreators(list: string) {
	const entries = parseImportEntries(list)
	return (
		entries.length > 0 &&
		entries.every(
			(entry) => entry != null && boundCreatorNamePattern.test(entry.imported),
		)
	)
}

function collectFacadeMatches(source: string): Array<FacadeMatch> {
	const named = [...source.matchAll(namedFacadeHeadPattern)].map(
		(match): FacadeMatch => ({
			match,
			repair: repairNamedFacade,
			creatorList: match[3]!,
			idLiteral: match[4]!,
		}),
	)
	const star = [...source.matchAll(starFacadeHeadPattern)].map(
		(match): FacadeMatch => ({
			match,
			repair: repairStarFacade,
			creatorList: match[5]!,
			idLiteral: match[6]!,
		}),
	)
	return [...named, ...star].sort(
		(left, right) => left.match.index! - right.match.index!,
	)
}

/** Rewrite one bundle module, or null when it has nothing to repair. */
export function repairInlinedFacadeBindings(input: {
	source: string
	allowedPackageIds: ReadonlySet<string>
}) {
	if (!input.source.includes('__kodyBaseRuntimeDefault')) return null
	const allocate = createNameAllocator(input.source)
	const pieces: Array<string> = []
	let cursor = 0
	const matches = collectFacadeMatches(input.source)
	for (const [matchIndex, facade] of matches.entries()) {
		const { match } = facade
		const packageId = parseStringLiteral(facade.idLiteral)
		if (packageId == null || !input.allowedPackageIds.has(packageId)) continue
		if (!importsOnlyBoundCreators(facade.creatorList)) continue
		const headStart = match.index!
		const headEnd = headStart + match[0].length
		// A facade ends before the next facade head, so a facade without its
		// end marker never swallows (and duplicates) the next one.
		const sectionEnd =
			matches[matchIndex + 1]?.match.index ?? input.source.length
		const tail = input.source.slice(headEnd, sectionEnd)
		const facadeEnd = facadeEndPattern.exec(tail)
		const facadeBody = facadeEnd ? tail.slice(0, facadeEnd.index) : ''
		if (!bindsOnlyPackage(facadeBody, facade.idLiteral)) continue
		const repaired = facade.repair({ match, packageId, allocate })
		if (repaired == null) continue
		pieces.push(
			input.source.slice(cursor, headStart),
			repaired.head,
			facadeEnd ? repaired.patchBody(facadeBody) : '',
		)
		cursor = headEnd + facadeBody.length
	}
	if (pieces.length === 0) return null
	pieces.push(input.source.slice(cursor))
	return pieces.join('')
}

/**
 * Bind `createAuthenticatedFetch` / `oauthClientCredentials` in every inlined
 * package facade of a stored bundle (see file comment). Returns the artifact
 * unchanged when no module needs it.
 */
export function repairInlinedFacadeBindingsInArtifact<
	Artifact extends RepairableArtifact,
>(artifact: Artifact): Artifact {
	const allowedPackageIds = new Set<string>()
	const ownPackageId = artifact.packageContext?.packageId?.trim()
	if (ownPackageId) allowedPackageIds.add(ownPackageId)
	for (const dependency of artifact.dependencies) {
		const packageId = dependency.packageId?.trim()
		if (packageId) allowedPackageIds.add(packageId)
	}
	if (allowedPackageIds.size === 0) return artifact
	let modules: WorkerLoaderModules | null = null
	for (const [modulePath, module] of Object.entries(artifact.modules)) {
		const source = moduleSource(module)
		if (source == null) continue
		const repaired = repairInlinedFacadeBindings({ source, allowedPackageIds })
		if (repaired == null) continue
		modules ??= { ...artifact.modules }
		modules[modulePath] = withModuleSource(module, repaired)
	}
	return modules ? { ...artifact, modules } : artifact
}
