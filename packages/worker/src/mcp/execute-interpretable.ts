/**
 * Fleet measurement of `q`: the share of MCP execute modules that are
 * interpretable pure glue (suitable for a hypothetical fixed-interpreter
 * tier). Measurement only — this module does not implement an interpreter
 * and does not change execution.
 *
 * Predicate (refined from spike PRs #2073 / #2074 against the current
 * execute / `kody:runtime` import graph):
 *
 * A module is **interpretable** (`q` numerator) iff it is pure orchestration
 * over host `kody.*` / `kody:runtime` capabilities. That means every runtime
 * import specifier is exactly `kody:runtime`, and the source does not use
 * ambient network or other isolate-local APIs an interpreter would not
 * implement. Type-only imports are ignored.
 *
 * Disqualifiers, first match wins as `reason` (documented order):
 *
 * 1. `unparseable` — source failed to parse; conservative: not interpretable
 * 2. `has_package_import` — `kody:@scope/pkg` (needs package RPC stubs)
 * 3. `has_npm` — bare npm specifier
 * 4. `has_node_builtin` — `node:` specifier
 * 5. `has_fetch` — ambient `fetch` / `globalThis.fetch`, or in-isolate
 *    `kody:runtime` helpers that themselves `fetch` with secret placeholders
 *    (`createAuthenticatedFetch`, `oauthClientCredentials`)
 * 6. `has_dynamic_import` — computed `import(expr)` (specifier not a literal)
 * 7. `has_unsupported_import` — any other non-`kody:runtime` specifier
 *    (`cloudflare:`, relative files, URL imports, unknown `kody:` schemes)
 *
 * Recording is a dedicated Analytics Engine dataset (not `USAGE_EVENTS`) so
 * the payload can stay free of user ids and source. Both classes share one
 * constant `index1` so they stay one sampling population — `q` is only valid
 * when the query proves `_sample_interval` stayed at 1, or when counts are
 * weighted by `_sample_interval`.
 *
 * ```sql
 * SELECT
 *   blob1 AS class,
 *   blob2 AS reason,
 *   SUM(_sample_interval) AS executes
 * FROM kody_execute_interpretable_events
 * WHERE timestamp > NOW() - INTERVAL '7' DAY
 * GROUP BY class, reason
 * ```
 *
 * `q = interpretable / (interpretable + non_interpretable)` from that
 * grouping (or `sum(if(blob1 = 'interpretable', _sample_interval, 0)) /
 * sum(_sample_interval)`).
 */

import {
	collectDynamicImportExpressionNodes,
	collectLiteralImportNodes,
	isBarePackageImportSpecifier,
} from '#worker/package-runtime/import-specifiers.ts'
import { parseModuleSource } from '#worker/module-source.ts'

export type ExecuteInterpretableClass = 'interpretable' | 'non_interpretable'

export const executeInterpretableReasons = [
	'glue',
	'unparseable',
	'has_package_import',
	'has_npm',
	'has_node_builtin',
	'has_fetch',
	'has_dynamic_import',
	'has_unsupported_import',
] as const

export type ExecuteInterpretableReason =
	(typeof executeInterpretableReasons)[number]

export type ExecuteInterpretableClassification = {
	class: ExecuteInterpretableClass
	reason: ExecuteInterpretableReason
}

export type ExecuteInterpretableTelemetryEnv = {
	EXECUTE_INTERPRETABLE_EVENTS?: AnalyticsEngineDataset
}

export const executeInterpretableTelemetryIndex = 'execute_interpretable_q'

const kodyRuntimeSpecifier = 'kody:runtime'
const kodyRuntimeNetworkHelpers = new Set([
	'createAuthenticatedFetch',
	'oauthClientCredentials',
])
const ambientFetchBindingNames = new Set([
	'fetch',
	...kodyRuntimeNetworkHelpers,
])
const globalObjectNames = new Set(['globalThis', 'global', 'self'])

const disqualifierPriority: ReadonlyArray<
	Exclude<ExecuteInterpretableReason, 'glue'>
> = [
	'unparseable',
	'has_package_import',
	'has_npm',
	'has_node_builtin',
	'has_fetch',
	'has_dynamic_import',
	'has_unsupported_import',
]

function readNodeType(node: unknown) {
	if (node == null || typeof node !== 'object') return null
	const type = (node as { type?: unknown }).type
	return typeof type === 'string' ? type : null
}

function readIdentifierName(node: unknown) {
	if (node == null || typeof node !== 'object') return null
	const typed = node as { type?: unknown; name?: unknown; value?: unknown }
	if (typed.type === 'Identifier' && typeof typed.name === 'string') {
		return typed.name
	}
	if (
		(typed.type === 'Literal' || typed.type === 'StringLiteral') &&
		typeof typed.value === 'string'
	) {
		return typed.value
	}
	return null
}

function classifyImportSpecifier(
	specifier: string,
): Exclude<
	ExecuteInterpretableReason,
	'glue' | 'unparseable' | 'has_fetch'
> | null {
	if (specifier === kodyRuntimeSpecifier) return null
	if (specifier.startsWith('kody:@')) return 'has_package_import'
	if (specifier.startsWith('node:')) return 'has_node_builtin'
	if (isBarePackageImportSpecifier(specifier)) return 'has_npm'
	return 'has_unsupported_import'
}

async function collectDisqualifiersFromSpecifiers(source: string) {
	const reasons = new Set<Exclude<ExecuteInterpretableReason, 'glue'>>()
	for (const specifier of (await collectLiteralImportNodes(source)).map(
		(node) => node.specifier,
	)) {
		const reason = classifyImportSpecifier(specifier)
		if (reason) reasons.add(reason)
	}
	for (const node of await collectDynamicImportExpressionNodes(source)) {
		if (node.literalSpecifier == null) {
			reasons.add('has_dynamic_import')
			continue
		}
		const reason = classifyImportSpecifier(node.literalSpecifier)
		if (reason) reasons.add(reason)
	}
	return reasons
}

function isAmbientFetchMember(node: unknown) {
	if (readNodeType(node) !== 'MemberExpression') return false
	const typed = node as {
		computed?: unknown
		object?: unknown
		property?: unknown
	}
	if (typed.computed === true) return false
	const objectName = readIdentifierName(typed.object)
	const propertyName = readIdentifierName(typed.property)
	if (propertyName != null && kodyRuntimeNetworkHelpers.has(propertyName)) {
		return true
	}
	return (
		propertyName === 'fetch' &&
		objectName != null &&
		globalObjectNames.has(objectName)
	)
}

function isAmbientFetchCallee(node: unknown) {
	const name = readIdentifierName(node)
	if (name != null && ambientFetchBindingNames.has(name)) return true
	return isAmbientFetchMember(node)
}

function importIntroducesAuthenticatedFetch(node: unknown) {
	if (readNodeType(node) !== 'ImportDeclaration') return false
	const typed = node as { source?: unknown; specifiers?: unknown }
	if (readIdentifierName(typed.source) !== kodyRuntimeSpecifier) return false
	if (!Array.isArray(typed.specifiers)) return false
	return typed.specifiers.some((specifier) => {
		const specifierType = readNodeType(specifier)
		if (specifierType === 'ImportSpecifier') {
			const imported = (specifier as { imported?: unknown }).imported
			const importedName = readIdentifierName(imported)
			return importedName != null && kodyRuntimeNetworkHelpers.has(importedName)
		}
		return false
	})
}

async function sourceUsesAmbientFetch(source: string) {
	function visit(node: unknown): boolean {
		if (node == null || typeof node !== 'object') return false
		if (Array.isArray(node)) return node.some((item) => visit(item))
		if (importIntroducesAuthenticatedFetch(node)) return true
		if (
			readNodeType(node) === 'CallExpression' &&
			isAmbientFetchCallee((node as { callee?: unknown }).callee)
		) {
			return true
		}
		for (const value of Object.values(node as Record<string, unknown>)) {
			if (value != null && typeof value === 'object' && visit(value)) {
				return true
			}
		}
		return false
	}

	try {
		return visit(await parseModuleSource(source))
	} catch {
		return false
	}
}

function pickPrimaryReason(
	reasons: ReadonlySet<Exclude<ExecuteInterpretableReason, 'glue'>>,
): Exclude<ExecuteInterpretableReason, 'glue'> {
	for (const reason of disqualifierPriority) {
		if (reasons.has(reason)) return reason
	}
	return 'has_unsupported_import'
}

/**
 * Cheap, deterministic classifier for one ad-hoc execute module source.
 * Uses the existing import-graph helpers plus a small AST walk for ambient
 * `fetch`. Does not inspect bundled output (bundling rewrites `kody:runtime`
 * and would hide the author's imports).
 */
export async function classifyExecuteInterpretable(
	source: string,
): Promise<ExecuteInterpretableClassification> {
	try {
		await parseModuleSource(source)
	} catch {
		return { class: 'non_interpretable', reason: 'unparseable' }
	}

	const reasons = await collectDisqualifiersFromSpecifiers(source)
	if (await sourceUsesAmbientFetch(source)) {
		reasons.add('has_fetch')
	}
	if (reasons.size === 0) {
		return { class: 'interpretable', reason: 'glue' }
	}
	return {
		class: 'non_interpretable',
		reason: pickPrimaryReason(reasons),
	}
}

/**
 * Record one execute-module classification. Synchronous, nonthrowing, and a
 * no-op when the dedicated Analytics Engine binding is absent. The event
 * contains no user, source, run, conversation, or request identity.
 */
export async function recordExecuteInterpretableEvent(
	env: ExecuteInterpretableTelemetryEnv,
	input: { source: string },
): Promise<void> {
	try {
		const classification = await classifyExecuteInterpretable(input.source)
		env.EXECUTE_INTERPRETABLE_EVENTS?.writeDataPoint({
			indexes: [executeInterpretableTelemetryIndex],
			blobs: [classification.class, classification.reason],
			doubles: [1],
		})
	} catch (error) {
		console.warn('execute-interpretable-event-failed', error)
	}
}
