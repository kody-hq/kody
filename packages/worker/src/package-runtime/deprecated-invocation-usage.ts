import { parseModuleSource } from '#worker/module-source.ts'
import { collectLiteralImportNodes } from './import-specifiers.ts'
import { packageSpecifierPrefix } from './package-import-resolution.ts'
import { isTypeDeclarationFilePath } from './static-kody-imports.ts'

/**
 * Permanent publish-time guard for unsupported invocation forms:
 * `packages.check`, `packages.invokeChecked`, object-only `packages.invoke`,
 * and literal dynamic `import("kody:@...")`. Publish checks fail on these;
 * permanent repair codemods cover mechanical migrations.
 */
export type DeprecatedInvocationUsageKind =
	| 'packages.check'
	| 'packages.invokeChecked'
	| 'packages.invoke-object'
	| 'dynamic-kody-import'

export type DeprecatedInvocationUsage = {
	filePath: string
	kind: DeprecatedInvocationUsageKind
}

const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/

type InvocationExpressionNode = {
	type?: string
	expression?: InvocationExpressionNode
}

async function collectDeprecatedPackagesMemberKinds(
	source: string,
): Promise<Set<DeprecatedInvocationUsageKind>> {
	const kinds = new Set<DeprecatedInvocationUsageKind>()
	let program: unknown
	try {
		program = await parseModuleSource(source)
	} catch {
		return kinds
	}

	function visit(node: unknown): void {
		if (node == null || typeof node !== 'object') return
		if (Array.isArray(node)) {
			for (const item of node) visit(item)
			return
		}
		if (!('type' in node)) return
		const typedNode = node as {
			type?: string
			computed?: boolean
			callee?: {
				type?: string
				computed?: boolean
				object?: { type?: string; name?: unknown }
				property?: { type?: string; name?: unknown }
			}
			arguments?: Array<InvocationExpressionNode>
			object?: { type?: string; name?: unknown }
			property?: { type?: string; name?: unknown }
		}
		let unwrappedFirstArgument = typedNode.arguments?.[0]
		while (
			unwrappedFirstArgument &&
			[
				'ParenthesizedExpression',
				'TSAsExpression',
				'TSNonNullExpression',
				'TSSatisfiesExpression',
				'TSTypeAssertion',
				'TypeCastExpression',
			].includes(unwrappedFirstArgument.type ?? '')
		) {
			unwrappedFirstArgument = unwrappedFirstArgument.expression
		}
		if (
			(typedNode.type === 'CallExpression' ||
				typedNode.type === 'OptionalCallExpression') &&
			(typedNode.callee?.type === 'MemberExpression' ||
				typedNode.callee?.type === 'OptionalMemberExpression') &&
			typedNode.callee.computed !== true &&
			typedNode.callee.object?.type === 'Identifier' &&
			typedNode.callee.object.name === 'packages' &&
			typedNode.callee.property?.type === 'Identifier' &&
			typedNode.callee.property.name === 'invoke' &&
			unwrappedFirstArgument?.type === 'ObjectExpression'
		) {
			kinds.add('packages.invoke-object')
		}
		if (
			// Babel emits OptionalMemberExpression for `packages?.check`.
			(typedNode.type === 'MemberExpression' ||
				typedNode.type === 'OptionalMemberExpression') &&
			typedNode.computed !== true &&
			typedNode.object?.type === 'Identifier' &&
			typedNode.object.name === 'packages' &&
			typedNode.property?.type === 'Identifier'
		) {
			if (typedNode.property.name === 'check') {
				kinds.add('packages.check')
			} else if (typedNode.property.name === 'invokeChecked') {
				kinds.add('packages.invokeChecked')
			}
		}
		for (const value of Object.values(node as Record<string, unknown>)) {
			if (value != null && typeof value === 'object') {
				visit(value)
			}
		}
	}

	visit(program)
	return kinds
}

async function moduleHasLiteralDynamicKodyImport(source: string) {
	return (await collectLiteralImportNodes(source)).some(
		(node) =>
			node.kind === 'dynamic' &&
			node.specifier.startsWith(packageSpecifierPrefix),
	)
}

export async function collectDeprecatedInvocationUsage(
	sourceFiles: Record<string, string>,
): Promise<Array<DeprecatedInvocationUsage>> {
	const usages: Array<DeprecatedInvocationUsage> = []
	for (const [filePath, source] of Object.entries(sourceFiles)) {
		if (!scannableModuleFilePattern.test(filePath)) continue
		if (isTypeDeclarationFilePath(filePath)) continue
		if (source.includes('packages')) {
			for (const kind of await collectDeprecatedPackagesMemberKinds(source)) {
				usages.push({ filePath, kind })
			}
		}
		if (
			source.includes(packageSpecifierPrefix) &&
			(await moduleHasLiteralDynamicKodyImport(source))
		) {
			usages.push({ filePath, kind: 'dynamic-kody-import' })
		}
	}
	return usages.sort(
		(left, right) =>
			left.filePath.localeCompare(right.filePath) ||
			left.kind.localeCompare(right.kind),
	)
}

const removedUsageReplacements: Record<DeprecatedInvocationUsageKind, string> =
	{
		'packages.check':
			'packages.check was removed: statically import kody:@scope/package/export when the name is known, or import(specifier) when the name is data',
		'packages.invokeChecked':
			'packages.invokeChecked was removed: use a static kody:@scope/pkg/export import when the target package is known at write time, import(specifier) when the name is data, or workflows for exactly-once',
		'packages.invoke-object':
			'object-only packages.invoke was removed: use a static kody:@owner/package/export import when the name is known, or import(specifier) when the name is data',
		'dynamic-kody-import':
			'literal dynamic import("kody:@...") was removed: use a static import and declare it in package.json#kody.dependencies when the name is known, or import(specifier) when the name is data',
	}

const maxReportedRemovedUsages = 5

export function formatRemovedInvocationUsageFailure(
	usages: Array<DeprecatedInvocationUsage>,
) {
	if (usages.length === 0) return null
	const shown = usages.slice(0, maxReportedRemovedUsages)
	const hiddenCount = usages.length - shown.length
	const details = shown
		.map(
			(usage) => `"${usage.filePath}": ${removedUsageReplacements[usage.kind]}`,
		)
		.join('; ')
	return `Package code uses the removed dynamic invocation surface: ${details}${
		hiddenCount > 0 ? ` (and ${hiddenCount} more)` : ''
	}. Use the permanent 0002-static-first-invocation or 0006-invoke-object-to-specifier package codemod for mechanical repairs.`
}
