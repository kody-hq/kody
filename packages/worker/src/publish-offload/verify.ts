import type { PublishedPackageArtifactBuildTarget } from '#worker/package-runtime/package-artifact-targets.ts'
import { collectBundlerResolvedSpecifiers } from '#worker/package-runtime/import-specifiers.ts'
import {
	publicRuntimeModulePath,
	resolveRelativeModulePath,
} from '#worker/package-runtime/module-graph-paths.ts'
import {
	buildPackageRuntimeModulePath,
	isKodyRuntimeModulePath,
} from '#worker/package-runtime/runtime-source-modules.ts'
import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'
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
const boundCreatorNamePattern = /__kodyCreatePackageBound[\w$]*/g
const boundCreatorCallPattern =
	/__kodyCreatePackageBound[\w$]*\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^)\s]+)\s*\)/g
const preBindingRepairNames = [
	'__kodyPreBindingBoundFetch',
	'__kodyPreBindingBoundKody',
	'__kodyMeterStaticPackageExport',
]

const namedImportPattern =
	/\bimport\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*(["'])[^"'\n]*\2/g
const platformModuleImportPatterns = [
	/\bimport\s*(?:[\w$]+\s*,\s*)?\*\s*as\s+[\w$]+\s*from\s*["'][^"'\n]*__kody_virtual__/,
	/\bexport\s*(?:\*|\{[^}]*\})\s*(?:as\s+[\w$]+\s*)?from\s*["'][^"'\n]*__kody_virtual__/,
	/\b(?:import|require)\s*\(\s*["'`][^"'`\n]*__kody_virtual__/,
]
const nonLiteralDynamicLoadPattern =
	/\b(?:import|require)\s*\(\s*(?!["'][^"'`\n]*["']\s*\))/

/**
 * The bound-identity check below reads `creator("<id>")` calls, so an
 * uploaded module may only name a creator in a named import (kept or
 * aliased to another creator name) or a direct literal call. Namespace
 * imports and re-exports of platform modules, and imports or requires of a
 * computed path, would reach a creator under another name and are refused.
 * Returns the direct calls.
 */
function assertBoundCreatorsOnlyCalledDirectly(input: {
	source: string
	label: string
}) {
	const { source, label } = input
	for (const pattern of platformModuleImportPatterns) {
		if (pattern.test(source)) {
			fail(
				`${label} imports a Kody platform module as a namespace or by re-export.`,
			)
		}
	}
	if (nonLiteralDynamicLoadPattern.test(source)) {
		fail(
			`${label} imports or requires a computed module path, which a build made outside Kody cloud may not do.`,
		)
	}
	const allowed = new Set<number>()
	for (const match of source.matchAll(namedImportPattern)) {
		const clauseStart = match.index + match[0].indexOf('{') + 1
		for (const name of match[1]!.matchAll(boundCreatorNamePattern)) {
			allowed.add(clauseStart + name.index)
		}
		for (const specifier of match[1]!.split(',')) {
			const [imported, local] = specifier.trim().split(/\s+as\s+/)
			const names = [imported, local].filter(Boolean) as Array<string>
			if (!names.some((name) => name.startsWith('__kodyCreatePackageBound'))) {
				continue
			}
			if (!names.every((name) => name.startsWith('__kodyCreatePackageBound'))) {
				fail(`${label} renames the runtime helper ${imported}.`)
			}
		}
	}
	const directCalls = [...source.matchAll(boundCreatorCallPattern)]
	for (const call of directCalls) allowed.add(call.index)
	for (const name of source.matchAll(boundCreatorNamePattern)) {
		if (!allowed.has(name.index)) {
			fail(
				`${label} refers to the runtime helper ${name[0]} outside a direct call.`,
			)
		}
	}
	return directCalls
}

function parseBoundId(raw: string) {
	if (raw.startsWith('"')) {
		try {
			return JSON.parse(raw) as string
		} catch {
			return null
		}
	}
	if (raw.startsWith("'")) return raw.slice(1, -1)
	return null
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
 * (another package's facade, a linked artifact's internals) is refused.
 * Returns the placeholders the module imports.
 */
function assertImportsStayInPackage(input: {
	path: string
	source: string
	label: string
	ownPackageId: string
	linkedImports: ReadonlyMap<string, string>
	referenced: Set<string>
}) {
	const specifiers = collectBundlerResolvedSpecifiers(input.source)
	if (specifiers === null) {
		fail(`${input.label} does not parse as a module.`)
	}
	for (const specifier of specifiers) {
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
		const source =
			typeof module === 'string' ? module : (module.js ?? module.cjs ?? null)
		if (source === null) continue
		for (const name of preBindingRepairNames) {
			if (source.includes(name)) {
				fail(
					`module "${path}" of "${uploaded.entryPoint}" uses the reserved runtime name ${name}.`,
				)
			}
		}
		const label = `module "${path}" of "${uploaded.entryPoint}"`
		const directCalls = assertBoundCreatorsOnlyCalledDirectly({
			source,
			label,
		})
		for (const match of directCalls) {
			const id = parseBoundId(match[1]!)
			if (id !== input.ownPackageId) {
				fail(
					`${label} binds runtime calls to ${id === null ? 'a computed package id' : `package "${id}"`}, not this package. A build made outside Kody cloud may not contain another Kody package; Kody links those itself.`,
				)
			}
		}
		assertImportsStayInPackage({
			path,
			source,
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

/**
 * The server rebuilds a sample and compares hashes. Smallest targets first,
 * so the re-check stays cheap; browser bundles are as good a witness as
 * worker bundles.
 */
export function pickServerRebuildSample<
	T extends { uploaded: PublishBuildTargetEntry },
>(matched: ReadonlyArray<T>, size: number) {
	const bytes = (entry: T) =>
		Object.values(entry.uploaded.modules).reduce(
			(total, module) => total + module.size,
			0,
		)
	return [...matched]
		.sort(
			(a, b) =>
				bytes(a) - bytes(b) ||
				a.uploaded.entryPoint.localeCompare(b.uploaded.entryPoint),
		)
		.slice(0, Math.max(0, size))
}

export function assertServerRebuildMatches(input: {
	uploaded: PublishBuildTargetEntry
	rebuilt: { mainModule: string; moduleHashes: Record<string, string> }
}) {
	const uploadedHashes = Object.fromEntries(
		Object.entries(input.uploaded.modules)
			.map(([path, module]) => [path, module.sha256] as const)
			.sort(([a], [b]) => a.localeCompare(b)),
	)
	const rebuiltHashes = Object.fromEntries(
		Object.entries(input.rebuilt.moduleHashes).sort(([a], [b]) =>
			a.localeCompare(b),
		),
	)
	if (
		input.rebuilt.mainModule !== input.uploaded.mainModule ||
		JSON.stringify(uploadedHashes) !== JSON.stringify(rebuiltHashes)
	) {
		fail(
			`the server rebuilt "${input.uploaded.entryPoint}" from the pushed commit and got different bytes than the upload, so the upload was not built from this tree with this builder.`,
		)
	}
}
