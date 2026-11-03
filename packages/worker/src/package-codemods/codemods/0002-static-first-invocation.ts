import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import {
	collectDeprecatedInvocationUsage,
	type DeprecatedInvocationUsage,
} from '#worker/package-runtime/deprecated-invocation-usage.ts'
import type {
	PackageCodemod,
	PackageCodemodContext,
	PackageCodemodFinding,
	PackageCodemodTransformResult,
} from '../types.ts'
import { invokeObjectToSpecifierCodemod } from './0006-invoke-object-to-specifier.ts'

export const staticFirstInvocationCodemodId = '0002-static-first-invocation'

const invokeCheckedDetectMessage =
	'Calls unsupported `packages.invokeChecked`; rewrites mechanically to scoped string-first `packages.invoke` when the target is safe to derive, otherwise flags the call for manual migration. A static `kody:@scope/pkg/export` import is preferable when the target package is known at write time.'

const checkDetectMessage =
	'Calls unsupported `packages.check`; `packages.invoke` already contract-checks before invoking, so restructure the call site manually (no mechanical rewrite preserves the contract return value).'

const dynamicImportDetectMessage =
	'Uses a literal dynamic `import("kody:@...")`; migrate manually — a static import (declared in `package.json#kody.dependencies`) when the target is known at write time, or `import(specifier)` when the name is data. Namespace semantics differ, so no mechanical rewrite is safe.'

const manualParseFailureMessage =
	'File references unsupported invocation forms but could not be parsed; replace them with `packages.invoke` / static imports manually.'

const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/

type AstNode = ModuleAstNode & {
	name?: unknown
	start?: number
	end?: number
	computed?: boolean
	object?: AstNode
	property?: AstNode
}

function isTypeDeclarationFilePath(path: string) {
	return (
		path.endsWith('.d.ts') || path.endsWith('.d.mts') || path.endsWith('.d.cts')
	)
}

function parseProgram(source: string): AstNode | null {
	try {
		return parseModuleSource(source) as unknown as AstNode
	} catch {
		return null
	}
}

/**
 * Textual net for the parse-failure path. The AST-based permanent publish guard
 * cannot classify unparseable files, so the codemod surfaces likely unsupported
 * forms as `needsManual` instead of silently scanning clean.
 */
function referencesDeprecatedSurface(source: string) {
	return (
		source.includes('invokeChecked') ||
		/packages\s*\??\.\s*check\b/.test(source) ||
		(source.includes('kody:@') && source.includes('import('))
	)
}

function collectUnparseableDeprecatedFiles(
	files: Record<string, string>,
): Array<string> {
	const paths: Array<string> = []
	for (const [path, source] of Object.entries(files)) {
		if (!scannableModuleFilePattern.test(path)) continue
		if (isTypeDeclarationFilePath(path)) continue
		if (!referencesDeprecatedSurface(source)) continue
		if (parseProgram(source) == null) {
			paths.push(path)
		}
	}
	return paths.sort((left, right) => left.localeCompare(right))
}

/**
 * Positions of the `invokeChecked` property identifier in
 * `packages.invokeChecked` / `packages?.invokeChecked` member expressions.
 * Only exact `packages` identifier objects match — the same shape the runtime
 * exposes and the publish-check deprecation collector warns on.
 */
function collectInvokeCheckedPropertyRanges(
	program: AstNode,
): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = []

	function visit(node: unknown): void {
		if (node == null || typeof node !== 'object') return
		if (Array.isArray(node)) {
			for (const item of node) visit(item)
			return
		}
		if (!('type' in node)) return
		const typedNode = node as AstNode
		if (
			(typedNode.type === 'MemberExpression' ||
				typedNode.type === 'OptionalMemberExpression') &&
			typedNode.computed !== true &&
			typedNode.object?.type === 'Identifier' &&
			typedNode.object.name === 'packages' &&
			typedNode.property?.type === 'Identifier' &&
			typedNode.property.name === 'invokeChecked' &&
			typeof typedNode.property.start === 'number' &&
			typeof typedNode.property.end === 'number'
		) {
			ranges.push({
				start: typedNode.property.start,
				end: typedNode.property.end,
			})
		}
		for (const value of Object.values(node as Record<string, unknown>)) {
			if (value != null && typeof value === 'object') {
				visit(value)
			}
		}
	}

	visit(program)
	return ranges.sort((left, right) => left.start - right.start)
}

function rewriteInvokeChecked(source: string): string | null {
	const program = parseProgram(source)
	if (!program) return null
	const ranges = collectInvokeCheckedPropertyRanges(program)
	if (ranges.length === 0) return source
	let rewritten = ''
	let cursor = 0
	for (const range of ranges) {
		rewritten += source.slice(cursor, range.start)
		rewritten += 'invoke'
		cursor = range.end
	}
	rewritten += source.slice(cursor)
	return rewritten
}

type StaticFirstDeprecatedInvocationUsage = DeprecatedInvocationUsage & {
	kind: Exclude<DeprecatedInvocationUsage['kind'], 'packages.invoke-object'>
}

function collectStaticFirstDeprecatedInvocationUsage(
	files: Record<string, string>,
): Array<StaticFirstDeprecatedInvocationUsage> {
	return collectDeprecatedInvocationUsage(files).filter(
		(usage): usage is StaticFirstDeprecatedInvocationUsage =>
			usage.kind !== 'packages.invoke-object',
	)
}

function findingMessageForUsage(
	usage: StaticFirstDeprecatedInvocationUsage,
): string {
	switch (usage.kind) {
		case 'packages.invokeChecked':
			return invokeCheckedDetectMessage
		case 'packages.check':
			return checkDetectMessage
		case 'dynamic-kody-import':
			return dynamicImportDetectMessage
		default: {
			const exhaustive: never = usage.kind
			void exhaustive
			throw new Error('Unhandled deprecated invocation usage kind.')
		}
	}
}

function detect(files: Record<string, string>): Array<PackageCodemodFinding> {
	const findings: Array<PackageCodemodFinding> =
		collectStaticFirstDeprecatedInvocationUsage(files).map((usage) => ({
			path: usage.filePath,
			message: findingMessageForUsage(usage),
		}))
	for (const path of collectUnparseableDeprecatedFiles(files)) {
		findings.push({ path, message: manualParseFailureMessage })
	}
	return findings.sort((left, right) =>
		(left.path ?? '').localeCompare(right.path ?? ''),
	)
}

function transform(
	files: Record<string, string>,
	context: PackageCodemodContext,
): PackageCodemodTransformResult {
	const usages = collectStaticFirstDeprecatedInvocationUsage(files)
	const nextFiles: Record<string, string> = { ...files }
	const changedPaths: Array<string> = []
	const needsManual: Array<PackageCodemodFinding> = []
	const unparseablePaths = collectUnparseableDeprecatedFiles(files)
	for (const path of unparseablePaths) {
		needsManual.push({ path, message: manualParseFailureMessage })
	}
	const unparseablePathSet = new Set(unparseablePaths)
	const invokeCheckedPaths = new Set(
		usages
			.filter((usage) => usage.kind === 'packages.invokeChecked')
			.map((usage) => usage.filePath),
	)

	for (const usage of usages) {
		// `packages.check` return values and dynamic-import namespaces have no
		// mechanical one-to-one rewrite; report them instead of guessing.
		if (usage.kind !== 'packages.invokeChecked') {
			needsManual.push({
				path: usage.filePath,
				message: findingMessageForUsage(usage),
			})
		}
	}

	for (const path of [...invokeCheckedPaths].sort((left, right) =>
		left.localeCompare(right),
	)) {
		const source = nextFiles[path]
		if (typeof source !== 'string') continue
		const rewritten = rewriteInvokeChecked(source)
		if (rewritten == null) {
			needsManual.push({ path, message: manualParseFailureMessage })
			continue
		}
		if (rewritten !== source) {
			nextFiles[path] = rewritten
			changedPaths.push(path)
		}
	}

	// Defensive verification over every rewrite candidate (not only changed
	// files): any detectable `packages.invokeChecked` member expression that
	// survives the rewrite pass needs a human.
	for (const path of [...invokeCheckedPaths].sort((left, right) =>
		left.localeCompare(right),
	)) {
		if (unparseablePathSet.has(path)) continue
		const source = nextFiles[path]
		if (!scannableModuleFilePattern.test(path)) continue
		if (isTypeDeclarationFilePath(path)) continue
		const remaining = collectDeprecatedInvocationUsage({
			[path]: source ?? '',
		}).filter((usage) => usage.kind === 'packages.invokeChecked')
		if (remaining.length > 0) {
			needsManual.push({
				path,
				message:
					'`packages.invokeChecked` member expressions remain after the rewrite; migrate manually.',
			})
		}
	}

	if (invokeCheckedPaths.size > 0) {
		const objectRepairFiles: Record<string, string> = {}
		const packageManifest = nextFiles['package.json']
		if (typeof packageManifest === 'string') {
			objectRepairFiles['package.json'] = packageManifest
		}
		for (const path of invokeCheckedPaths) {
			const source = nextFiles[path]
			if (typeof source === 'string') {
				objectRepairFiles[path] = source
			}
		}
		const objectRepair = invokeObjectToSpecifierCodemod.transform(
			objectRepairFiles,
			context,
		)
		if (objectRepair.needsManual.length > 0) {
			return {
				files: { ...files },
				changed: false,
				changedPaths: [],
				needsManual: [...needsManual, ...objectRepair.needsManual],
			}
		}
		for (const path of objectRepair.changedPaths) {
			const source = objectRepair.files[path]
			if (typeof source !== 'string') continue
			nextFiles[path] = source
			if (!changedPaths.includes(path)) {
				changedPaths.push(path)
			}
		}
		needsManual.push(...objectRepair.needsManual)
	}

	return {
		files: nextFiles,
		changed: changedPaths.length > 0,
		changedPaths: changedPaths.sort((left, right) => left.localeCompare(right)),
		needsManual,
	}
}

/**
 * Permanent repair path for the static-first invocation guard:
 *
 * - `packages.invokeChecked(...)` is renamed mechanically, then codemod 0006
 *   converts safe object inputs to scoped string-first `packages.invoke(...)`.
 *   Ambiguous targets remain `needsManual` instead of producing removed API.
 * - `packages.check(...)` and literal dynamic `import("kody:@...")` have no
 *   safe mechanical rewrite (return values / namespace semantics differ), so
 *   they surface as `needsManual` findings naming the replacement.
 */
export const staticFirstInvocationCodemod: PackageCodemod = {
	id: staticFirstInvocationCodemodId,
	description:
		'Repair unsupported packages.invokeChecked calls as scoped string-first packages.invoke and flag ambiguous targets, packages.check, and literal dynamic import("kody:@...") for manual replacement.',
	detect,
	transform,
}
