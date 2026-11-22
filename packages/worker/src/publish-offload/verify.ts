import type { PublishedPackageArtifactBuildTarget } from '#worker/package-runtime/package-artifact-targets.ts'
import { isKodyVirtualImportSpecifier } from '#worker/package-runtime/import-specifiers.ts'
import {
	publicRuntimeModulePath,
	resolveRelativeModulePath,
} from '#worker/package-runtime/module-graph-paths.ts'
import {
	buildPackageRuntimeModulePath,
	isKodyRuntimeModulePath,
} from '#worker/package-runtime/runtime-source-modules.ts'
import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import { snapshotStringToBytes } from '#universal/package-file-media.ts'
import { sha256Hex, workerLoaderModuleBytes } from './module-hashes.ts'
import { publishOffloadLimits } from './policy.ts'
import {
	publishBuilderVersion,
	type PublishBuildDocument,
	type PublishBuildFileEntry,
	type PublishBuildTargetEntry,
} from './types.ts'

/**
 * Server-side checks for a bundle built outside the worker. Nothing the
 * builder reports is trusted except the module bytes themselves: the tree,
 * the target set, and every package a bundle acts as are checked against
 * what the server derives from the pushed commit.
 */

export class PublishBuildVerificationError extends Error {
	override name = 'PublishBuildVerificationError'
}

function fail(message: string): never {
	throw new PublishBuildVerificationError(message)
}

export function assertSupportedBuilderVersion(document: PublishBuildDocument) {
	if (document.builderVersion !== publishBuilderVersion) {
		fail(
			`the build came from builder version ${String(document.builderVersion)}, but this server accepts version ${publishBuilderVersion}. Update the Kody CLI (or the execution context daemon) and build again.`,
		)
	}
}

/**
 * The builder's per-file sha256 manifest must equal the server's own view of
 * the pushed commit exactly: same paths, sizes, and hashes, nothing extra
 * and nothing missing. Files are hashed one at a time.
 */
export async function verifySourceManifest(input: {
	serverFiles: Record<string, string>
	claimed: ReadonlyArray<PublishBuildFileEntry>
}) {
	const claimedByPath = new Map<string, PublishBuildFileEntry>()
	let totalBytes = 0
	for (const entry of input.claimed) {
		if (claimedByPath.has(entry.path)) {
			fail(`the build manifest lists "${entry.path}" twice.`)
		}
		claimedByPath.set(entry.path, entry)
	}
	for (const [path, content] of Object.entries(input.serverFiles)) {
		const claimed = claimedByPath.get(path)
		if (!claimed) {
			fail(
				`"${path}" is in the pushed commit but not in the build manifest, so the build did not use the pushed tree.`,
			)
		}
		// Bytes the snapshot string stands for (latin1 for binaries), which
		// is what the builder hashes too.
		const bytes = snapshotStringToBytes(content, path)
		totalBytes += bytes.byteLength
		if (totalBytes > publishOffloadLimits.maxSourceBytes) {
			fail(
				`the package source is over the ${publishOffloadLimits.maxSourceBytes / 1024 / 1024} MiB source limit.`,
			)
		}
		if (claimed.size !== bytes.byteLength) {
			fail(
				`"${path}" is ${bytes.byteLength} bytes in the pushed commit but ${claimed.size} bytes in the build manifest (uncommitted edits?).`,
			)
		}
		if ((await sha256Hex(bytes)) !== claimed.sha256) {
			fail(
				`"${path}" differs from the pushed commit (its sha256 does not match; uncommitted edits?).`,
			)
		}
		claimedByPath.delete(path)
	}
	const extra = [...claimedByPath.keys()]
	if (extra.length > 0) {
		fail(
			`the build manifest lists files that are not in the pushed commit: ${extra
				.slice(0, 5)
				.map((path) => `"${path}"`)
				.join(
					', ',
				)}${extra.length > 5 ? ` and ${extra.length - 5} more` : ''}.`,
		)
	}
}

function targetKey(target: {
	kind: string
	bundleKind: string
	artifactName: string | null
	entryPoint: string
}) {
	return JSON.stringify([
		target.kind,
		target.bundleKind,
		target.artifactName ?? null,
		target.entryPoint,
	])
}

/** Exactly the targets the server derives from the manifest, no more. */
export function matchUploadedTargets(input: {
	expected: ReadonlyArray<PublishedPackageArtifactBuildTarget>
	uploaded: ReadonlyArray<PublishBuildTargetEntry>
}) {
	const uploadedByKey = new Map<string, PublishBuildTargetEntry>()
	for (const target of input.uploaded) {
		const key = targetKey(target)
		if (uploadedByKey.has(key)) {
			fail(`the build uploaded target ${target.entryPoint} twice.`)
		}
		uploadedByKey.set(key, target)
	}
	const matched: Array<{
		target: PublishedPackageArtifactBuildTarget
		uploaded: PublishBuildTargetEntry
	}> = []
	for (const target of input.expected) {
		const key = targetKey({
			kind: target.kind,
			bundleKind: target.bundleKind,
			artifactName: target.artifactName ?? null,
			entryPoint: target.entryPoint,
		})
		const uploaded = uploadedByKey.get(key)
		if (!uploaded) {
			fail(
				`the build is missing the ${target.bundleKind} target for "${target.entryPoint}" that this commit's package.json declares.`,
			)
		}
		matched.push({ target, uploaded })
		uploadedByKey.delete(key)
	}
	if (uploadedByKey.size > 0) {
		const extra = [...uploadedByKey.values()][0]!
		fail(
			`the build uploaded a target this commit does not declare ("${extra.entryPoint}", ${extra.bundleKind}).`,
		)
	}
	return matched
}

const platformVirtualPathPattern = /(^|\/)\.__kody_virtual__\//
const linkedPathPattern = /(^|\/)\.__kody_linked__\//
const kodyModuleMarkerPattern = /__kody_(?:virtual|linked)__/i
const platformModuleMarkerPattern = /__kody_virtual__/i
const boundCreatorPrefix = '__kodyCreatePackageBound'
const preBindingRepairNames = [
	'__kodyPreBindingBoundFetch',
	'__kodyPreBindingBoundKody',
	'__kodyMeterStaticPackageExport',
]

type AstNode = ModuleAstNode & { start?: number | null; end?: number | null }

function isAstNode(value: unknown): value is AstNode {
	return (
		value != null &&
		typeof value === 'object' &&
		typeof (value as { type?: unknown }).type === 'string'
	)
}

function isBoundCreatorName(name: unknown): name is string {
	return typeof name === 'string' && name.startsWith(boundCreatorPrefix)
}

/**
 * A string or substitution-free template written without escapes, so the
 * specifier the loader resolves is the text the checks read.
 */
function readPlainLiteral(node: unknown) {
	if (!isAstNode(node)) return null
	if (node.type === 'StringLiteral') {
		const raw = (node.extra as { raw?: unknown } | undefined)?.raw
		const value = node.value
		if (typeof raw !== 'string' || typeof value !== 'string') return null
		return { value, escaped: raw.slice(1, -1) !== value }
	}
	if (node.type === 'TemplateLiteral') {
		const expressions = node.expressions as Array<unknown>
		const quasis = node.quasis as Array<{
			value: { raw: string; cooked?: string | null }
		}>
		if (expressions.length !== 0 || quasis.length !== 1) return null
		const { raw, cooked } = quasis[0]!.value
		if (typeof cooked !== 'string') return null
		return { value: cooked, escaped: raw !== cooked }
	}
	return null
}

function matchesMarker(pattern: RegExp, specifier: string) {
	if (pattern.test(specifier)) return true
	const decoded = decodeSpecifier(specifier)
	// An undecodable specifier could hide a marker, so it counts as one.
	return decoded.kind === 'malformed_uri' || pattern.test(decoded.value)
}

function decodeSpecifier(
	specifier: string,
): { kind: 'ok'; value: string } | { kind: 'malformed_uri' } {
	try {
		return { kind: 'ok', value: decodeURIComponent(specifier) }
	} catch {
		return { kind: 'malformed_uri' }
	}
}

function namesKodyModule(specifier: string) {
	return matchesMarker(kodyModuleMarkerPattern, specifier)
}

function namesPlatformModule(specifier: string) {
	return matchesMarker(platformModuleMarkerPattern, specifier)
}

/**
 * Parses an uploaded module and checks how it reaches Kody modules and the
 * package-bound runtime creators. The identity check reads
 * `creator("<id>")` calls, so a creator may only be imported by its plain
 * name from a Kody module (kept, or aliased to another creator name) and
 * then called directly with a string literal. Platform modules may only be
 * imported with plain named or default imports: no namespace imports,
 * re-exports, string import names, `import()` or `require()`. Specifiers
 * may not use escapes, and computed `import()` / `require()` are refused.
 * Returns every static specifier and every creator call's package id.
 */
async function inspectUploadedModule(input: { source: string; label: string }) {
	const { source, label } = input
	let program: unknown
	try {
		program = await parseModuleSource(source)
	} catch (error) {
		throw new PublishBuildVerificationError(
			`${label} does not parse as a module.`,
			{ cause: error },
		)
	}
	const specifiers: Array<string> = []
	const boundIds: Array<string | null> = []
	const allowedCreatorNodes = new Set<unknown>()

	function readSpecifier(node: unknown, what: string) {
		const literal = readPlainLiteral(node)
		if (literal === null) {
			fail(
				`${label} ${what} a computed module path, which a build made outside Kody cloud may not do.`,
			)
		}
		if (literal.escaped) {
			fail(`${label} writes a module path with escape sequences.`)
		}
		const specifier = literal.value
		if (
			namesKodyModule(specifier) &&
			!specifier.startsWith('./') &&
			!specifier.startsWith('../')
		) {
			fail(
				`${label} imports "${specifier}", which is not part of this package.`,
			)
		}
		specifiers.push(specifier)
		return specifier
	}

	function checkImportDeclaration(node: AstNode) {
		const specifier = readSpecifier(node.source, 'imports')
		const platform = namesPlatformModule(specifier)
		for (const entry of (node.specifiers as Array<AstNode>) ?? []) {
			const local = (entry.local as AstNode | undefined)?.name
			if (entry.type === 'ImportNamespaceSpecifier') {
				if (platform) {
					fail(`${label} imports a Kody platform module as a namespace.`)
				}
				continue
			}
			if (entry.type === 'ImportDefaultSpecifier') {
				if (isBoundCreatorName(local)) {
					fail(`${label} renames a default import to ${local}.`)
				}
				continue
			}
			const imported = entry.imported as AstNode
			if (imported.type !== 'Identifier') {
				if (platform) {
					fail(`${label} imports a Kody platform export by a string name.`)
				}
				if (isBoundCreatorName(local)) {
					fail(`${label} renames an import to ${local}.`)
				}
				continue
			}
			const importedName = imported.name as string
			if (isBoundCreatorName(importedName) !== isBoundCreatorName(local)) {
				fail(`${label} renames the runtime helper ${importedName}.`)
			}
			allowedCreatorNodes.add(imported)
			allowedCreatorNodes.add(entry.local)
		}
	}

	function checkCreatorCall(node: AstNode) {
		const callee = node.callee as AstNode
		if (callee.type !== 'Identifier' || !isBoundCreatorName(callee.name)) {
			return
		}
		allowedCreatorNodes.add(callee)
		const args = node.arguments as Array<AstNode>
		const literal = args.length === 1 ? readPlainLiteral(args[0]) : null
		boundIds.push(literal?.value ?? null)
	}

	function visit(node: unknown): void {
		if (Array.isArray(node)) {
			for (const item of node) visit(item)
			return
		}
		if (!isAstNode(node)) return
		switch (node.type) {
			case 'ImportDeclaration':
				checkImportDeclaration(node)
				break
			case 'ExportAllDeclaration':
			case 'ExportNamedDeclaration':
				if (node.source != null) {
					const specifier = readSpecifier(node.source, 'exports')
					if (namesPlatformModule(specifier)) {
						fail(`${label} re-exports a Kody platform module.`)
					}
				}
				break
			case 'ImportExpression': {
				const specifier = readSpecifier(node.source, 'imports')
				if (namesPlatformModule(specifier)) {
					fail(`${label} imports a Kody platform module dynamically.`)
				}
				break
			}
			case 'CallExpression': {
				const callee = node.callee as AstNode
				if (
					callee.type === 'Import' ||
					(callee.type === 'Identifier' && callee.name === 'require')
				) {
					const specifier = readSpecifier(
						(node.arguments as Array<unknown>)[0],
						callee.type === 'Import' ? 'imports' : 'requires',
					)
					if (namesPlatformModule(specifier)) {
						fail(`${label} imports a Kody platform module dynamically.`)
					}
				}
				checkCreatorCall(node)
				break
			}
			case 'Identifier':
				if (isBoundCreatorName(node.name) && !allowedCreatorNodes.has(node)) {
					fail(
						`${label} refers to the runtime helper ${node.name} outside a direct call.`,
					)
				}
				break
			default:
				break
		}
		for (const [key, value] of Object.entries(node)) {
			if (
				key === 'loc' ||
				key === 'extra' ||
				key === 'leadingComments' ||
				key === 'trailingComments' ||
				key === 'innerComments'
			) {
				continue
			}
			if (value != null && typeof value === 'object') visit(value)
		}
	}
	visit(program)
	return { specifiers, boundIds }
}

function assertSafeModulePath(path: string) {
	if (
		path.length === 0 ||
		path.length > 1024 ||
		path.startsWith('/') ||
		path.includes('\\') ||
		path.includes('\0') ||
		path.split('/').some((segment) => segment === '..' || segment === '')
	) {
		fail(`the build uploaded a module with an unsafe path "${path}".`)
	}
	if (platformVirtualPathPattern.test(path)) {
		fail(
			`the build uploaded "${path}", but platform modules under .__kody_virtual__/ are supplied by Kody at load time and cannot come from a build.`,
		)
	}
	if (linkedPathPattern.test(path)) {
		fail(
			`the build uploaded "${path}", but other Kody packages under .__kody_linked__/ are linked by Kody and cannot come from a build.`,
		)
	}
}

/**
 * 6C: every relative import an uploaded module makes stays inside the
 * upload, is the shared runtime or this package's own runtime facade, or is
 * a linked placeholder for a Kody package the source imports. Anything else
 * (another package's facade, a linked artifact's internals) is refused, and
 * so is a `kody:` import the build left unrewritten.
 * Returns the placeholders the module imports.
 */
function assertImportsStayInPackage(input: {
	path: string
	specifiers: ReadonlyArray<string>
	label: string
	ownPackageId: string
	linkedImports: ReadonlyMap<string, string>
	referenced: Set<string>
}) {
	for (const specifier of input.specifiers) {
		if (isKodyVirtualImportSpecifier(specifier)) {
			fail(
				`${input.label} still imports "${specifier}". A build rewrites kody: imports to modules Kody supplies at load time, and this one did not, so the bundle would fail to load. Update the Kody CLI (or the execution context daemon) and build again, or publish with --context cloud.`,
			)
		}
		if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue
		const resolved = resolveRelativeModulePath(input.path, specifier)
		if (resolved && linkedPathPattern.test(resolved)) {
			if (!input.linkedImports.has(resolved)) {
				fail(
					`${input.label} imports "${resolved}", which is not a Kody package this source imports.`,
				)
			}
			input.referenced.add(resolved)
			continue
		}
		if (
			!resolved ||
			(platformVirtualPathPattern.test(resolved) &&
				!isKodyRuntimeModulePath(resolved) &&
				resolved !== publicRuntimeModulePath &&
				resolved !== buildPackageRuntimeModulePath(input.ownPackageId))
		) {
			fail(
				`${input.label} imports "${specifier}", which is not part of this package.`,
			)
		}
	}
}

/**
 * One uploaded target, after its bytes were read back from staging: the
 * hashes and sizes match the sealed document, it stays under the per-target
 * storage cap, and every package-bound runtime call acts as the package
 * itself. Other packages' code and bindings only ever come from Kody's link
 * step (6C), so an upload that binds another package id inlined it or
 * forged it.
 */
export async function verifyUploadedTargetModules(input: {
	uploaded: PublishBuildTargetEntry
	modules: WorkerLoaderModules
	ownPackageId: string
	/** Server-derived: placeholder path → the `kody:@…` import it stands for. */
	linkedImports: ReadonlyMap<string, string>
}) {
	const { uploaded } = input
	const referencedLinkedImports = new Set<string>()
	if (!(uploaded.mainModule in input.modules)) {
		fail(
			`target "${uploaded.entryPoint}" names main module "${uploaded.mainModule}", which it did not upload.`,
		)
	}
	const declared = Object.keys(uploaded.modules).sort()
	const received = Object.keys(input.modules).sort()
	if (JSON.stringify(declared) !== JSON.stringify(received)) {
		fail(
			`target "${uploaded.entryPoint}" uploaded a different module list than it sealed.`,
		)
	}
	let totalBytes = 0
	for (const path of received) {
		assertSafeModulePath(path)
		const bytes = workerLoaderModuleBytes(input.modules[path]!)
		const entry = uploaded.modules[path]!
		totalBytes += bytes.byteLength
		if (bytes.byteLength !== entry.size) {
			fail(
				`module "${path}" of "${uploaded.entryPoint}" is not the size it sealed.`,
			)
		}
		if ((await sha256Hex(bytes)) !== entry.sha256) {
			fail(
				`module "${path}" of "${uploaded.entryPoint}" does not match its sealed sha256.`,
			)
		}
		const module = input.modules[path]!
		const label = `module "${path}" of "${uploaded.entryPoint}"`
		if (typeof module !== 'string' && module.cjs !== undefined) {
			fail(`${label} is a CommonJS module, which a build never produces.`)
		}
		const source = typeof module === 'string' ? module : (module.js ?? null)
		if (source === null) continue
		for (const name of preBindingRepairNames) {
			if (source.includes(name)) {
				fail(`${label} uses the reserved runtime name ${name}.`)
			}
		}
		const { specifiers, boundIds } = await inspectUploadedModule({
			source,
			label,
		})
		for (const id of boundIds) {
			if (id !== input.ownPackageId) {
				fail(
					`${label} binds runtime calls to ${id === null ? 'a computed package id' : `package "${id}"`}, not this package. A build made outside Kody cloud may not contain another Kody package; Kody links those itself.`,
				)
			}
		}
		assertImportsStayInPackage({
			path,
			specifiers,
			label,
			ownPackageId: input.ownPackageId,
			linkedImports: input.linkedImports,
			referenced: referencedLinkedImports,
		})
	}
	if (totalBytes > publishOffloadLimits.maxTargetBytes) {
		fail(
			`target "${uploaded.entryPoint}" is ${(totalBytes / 1024 / 1024).toFixed(1)} MiB, over the ${publishOffloadLimits.maxTargetBytes / 1024 / 1024} MiB per-target storage limit. Split the entrypoint or drop heavy dependencies.`,
		)
	}
	return { totalBytes, referencedLinkedImports }
}

function moduleHashesKey(entry: PublishBuildTargetEntry) {
	return JSON.stringify(
		Object.entries(entry.modules)
			.map(([path, module]) => [path, module.sha256] as const)
			.sort(([a], [b]) => a.localeCompare(b)),
	)
}

/**
 * Targets that build the same bundle (an export and the jobs on its entry
 * file) all serve the upload Kody keeps for that build, so every other upload
 * for it must carry the same bytes. Otherwise a target could pass its checks
 * on an upload Kody never serves.
 */
export function assertSameBuildUploadMatches(input: {
	kept: PublishBuildTargetEntry
	uploaded: PublishBuildTargetEntry
}) {
	if (
		input.kept.mainModule !== input.uploaded.mainModule ||
		moduleHashesKey(input.kept) !== moduleHashesKey(input.uploaded)
	) {
		fail(
			`two targets upload different bytes for the same ${input.uploaded.bundleKind} build of "${input.uploaded.entryPoint}", so the upload is not one build of this tree.`,
		)
	}
}
