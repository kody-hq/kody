import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'

/**
 * Published bundles inline each package's `kody:runtime` facade (only the
 * shared runtime module stays external). Facades built before
 * `createAuthenticatedFetch` and `oauthClientCredentials` joined
 * `packageBoundRuntimeExports` import those two straight from the shared
 * runtime, so package code calls the run's own helper and acts as the caller
 * (an integration locked to the package refuses it as "execute").
 *
 * This read-time repair binds them the way the current builder does: inside
 * each inlined facade section it swaps the shared import for
 * `var <local> = __kodyCreatePackageBound...(<id>)`. The id is the one the
 * facade already binds `kody` to, and it must be bundler provenance for the
 * artifact. The bound helper only reaches the authority that facade's
 * `kody` and `fetch` already hold. Current bundles have nothing to rewrite.
 */

type RepairableArtifact = {
	modules: WorkerLoaderModules
	dependencies: Array<{ packageId?: string }>
	packageContext: { packageId: string } | null
}

/**
 * The head of a facade as the builder emits it and esbuild keeps it: the
 * shared-runtime re-export import, the base default import from the same
 * module, then the lexical `fetch` and `kody` bound to the package id.
 * Matching the whole head (not a banner comment) also finds facades of
 * packages inlined from another package's published bundle.
 */
const facadeHeadPattern = new RegExp(
	[
		String.raw`^import\s*\{([^}]*)\}\s*from\s*("[^"\n]*\.__kody_virtual__\/runtime\.js");?[ \t]*\n`,
		String.raw`import\s+__kodyBaseRuntimeDefault\d*\s*,\s*\{[^}]*\}\s*from\s*\2;?[ \t]*\n`,
		String.raw`var __kodyBoundFetch\d* = __kodyCreatePackageBoundFetch\d*\(("[^"\n]*")\);[ \t]*\n`,
		String.raw`var kody\d* = __kodyCreatePackageBoundKody\d*\(\3\);`,
	].join(''),
	'gm',
)
const facadeEndPattern = /^var KodyRuntime\d* = /m
const boundDefaultEntriesPattern = /Object\.entries\(\{([^}]*)\}\)/

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

function repairFacadeImport(input: {
	importList: string
	specifier: string
	packageId: string
	allocate: (base: string) => string
}) {
	const entries = parseImportEntries(input.importList)
	if (entries.some((entry) => entry == null)) return null
	const parsed = entries.filter((entry) => entry != null)
	const targets = parsed.filter((entry) =>
		Object.hasOwn(facadeRepairCreators, entry.imported),
	)
	if (targets.length === 0) return null
	const kept = parsed.filter((entry) => !targets.includes(entry))
	const id = JSON.stringify(input.packageId)
	const creatorImports: Array<string> = []
	const bindings: Array<string> = []
	for (const target of targets) {
		const creator = facadeRepairCreators[target.imported]!
		const alias = input.allocate(creator)
		creatorImports.push(alias === creator ? creator : `${creator} as ${alias}`)
		bindings.push(`var ${target.local} = ${alias}(${id});`)
	}
	return {
		imports: [
			...(kept.length > 0
				? [
						`import { ${kept.map((entry) => entry.entry).join(', ')} } from ${input.specifier};`,
					]
				: []),
			`import { ${creatorImports.join(', ')} } from ${input.specifier};`,
		].join('\n'),
		bindings: bindings.join('\n'),
		defaultEntries: targets
			.map((target) => `${target.imported}: ${target.local}`)
			.join(', '),
	}
}

/** Rewrite one bundle module, or null when it has nothing to repair. */
export function repairInlinedFacadeBindings(input: {
	source: string
	allowedPackageIds: ReadonlySet<string>
}) {
	if (!input.source.includes('__kodyCreatePackageBoundKody')) return null
	const allocate = createNameAllocator(input.source)
	const pieces: Array<string> = []
	let cursor = 0
	for (const match of input.source.matchAll(facadeHeadPattern)) {
		const [head, importList, specifier, idLiteral] = match
		let packageId: unknown
		try {
			packageId = JSON.parse(idLiteral!)
		} catch {
			continue
		}
		if (
			typeof packageId !== 'string' ||
			!input.allowedPackageIds.has(packageId)
		) {
			continue
		}
		const repaired = repairFacadeImport({
			importList: importList!,
			specifier: specifier!,
			packageId,
			allocate,
		})
		if (repaired == null) continue
		const headStart = match.index
		const headEnd = headStart + head.length
		// Shared import first, then the rest of the head (base default import,
		// fetch, kody), then the bound helpers.
		const restOfHead = head.slice(head.indexOf('\n') + 1)
		const tail = input.source.slice(headEnd)
		const facadeEnd = facadeEndPattern.exec(tail)
		const facadeBody = facadeEnd ? tail.slice(0, facadeEnd.index) : ''
		const patchedBody = facadeEnd
			? facadeBody.replace(
					boundDefaultEntriesPattern,
					(_whole, body: string) =>
						`Object.entries({${body.trimEnd()}, ${repaired.defaultEntries} })`,
				)
			: ''
		pieces.push(
			input.source.slice(cursor, headStart),
			`${repaired.imports}\n${restOfHead}\n${repaired.bindings}`,
			patchedBody,
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
