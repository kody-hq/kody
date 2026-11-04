import type { PublishedPackageArtifactBuildTarget } from '#worker/package-runtime/package-artifact-targets.ts'
import type { BundleArtifactDependency } from '#worker/package-runtime/published-runtime-artifacts.ts'
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
const boundCreatorNamePattern = /__kodyCreatePackageBound[\w$]*/g
const boundCreatorCallPattern =
	/__kodyCreatePackageBound[\w$]*\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^)\s]+)\s*\)/g
const preBindingRepairNames = [
	'__kodyPreBindingBoundFetch',
	'__kodyPreBindingBoundKody',
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
}

/**
 * One uploaded target, after its bytes were read back from staging: the
 * hashes and sizes match the sealed document, it stays under the per-target
 * storage cap, and every package-bound runtime call acts as the package
 * itself or a dependency the server computed (never another package).
 */
export async function verifyUploadedTargetModules(input: {
	uploaded: PublishBuildTargetEntry
	modules: WorkerLoaderModules
	ownPackageId: string
	allowedActsAsPackageIds: ReadonlySet<string>
}) {
	const { uploaded } = input
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
		const directCalls = assertBoundCreatorsOnlyCalledDirectly({
			source,
			label: `module "${path}" of "${uploaded.entryPoint}"`,
		})
		for (const match of directCalls) {
			const id = parseBoundId(match[1]!)
			if (
				id === null ||
				(id !== input.ownPackageId && !input.allowedActsAsPackageIds.has(id))
			) {
				fail(
					`module "${path}" of "${uploaded.entryPoint}" binds runtime calls to ${id === null ? 'a computed package id' : `package "${id}"`}, which is neither this package nor a dependency the server resolved from source.`,
				)
			}
		}
	}
	if (totalBytes > publishOffloadLimits.maxTargetBytes) {
		fail(
			`target "${uploaded.entryPoint}" is ${(totalBytes / 1024 / 1024).toFixed(1)} MiB, over the ${publishOffloadLimits.maxTargetBytes / 1024 / 1024} MiB per-target storage limit. Split the entrypoint or drop heavy dependencies.`,
		)
	}
	return { totalBytes }
}

/**
 * 6A: a bundle built outside the worker may only inline packages the
 * publisher can write. `dependencies` is the server's own resolution from
 * source, so a builder cannot hide one.
 */
export function assertInlinedDependenciesWritable(input: {
	entryPoint: string
	ownPackageId: string
	dependencies: ReadonlyArray<BundleArtifactDependency>
	writablePackageIds: ReadonlySet<string>
}) {
	const blocked = input.dependencies.filter(
		(dependency) =>
			!dependency.packageId ||
			(dependency.packageId !== input.ownPackageId &&
				!input.writablePackageIds.has(dependency.packageId)),
	)
	if (blocked.length === 0) return
	const names = blocked
		.map((dependency) => `"${dependency.packageName ?? dependency.kodyId}"`)
		.join(', ')
	fail(
		`"${input.entryPoint}" inlines ${names}, and a build made outside Kody cloud may only inline packages you can write. Publish this package on Kody cloud (drop --build), or ask that package's owner for write access.`,
	)
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
