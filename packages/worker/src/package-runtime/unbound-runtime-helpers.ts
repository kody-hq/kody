import { parseModuleSource } from '#worker/module-source.ts'
import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	isKodyPublicRuntimeModulePath,
	isKodyRuntimeModulePath,
} from './module-graph.ts'

/**
 * Optional `kody:runtime` exports intentionally stay falsy (`undefined` /
 * `null`) when the execution context does not bind them, so `if (storage)`
 * guards keep working. The cost is that guard-less access throws a bare
 * `Cannot read properties of undefined (reading 'sql')` / `X is not a
 * function` TypeError with no hint that the helper simply was not bound to
 * the call. This module matches such sandbox errors against the module
 * graph's actual `kody:runtime` imports so the execute pipeline can attach a
 * structured, actionable message (see `getExecutionErrorDetails` in
 * `#mcp/executor.ts`).
 */

export type UnboundRuntimeHelperAccess = {
	helperName: string
	reference: string
}

type RuntimeImportBinding =
	| { kind: 'named'; helperName: string; localName: string }
	| { kind: 'namespace'; localName: string }

const propertyReadErrorPattern =
	/Cannot read properties of (?:undefined|null) \(reading '([^']+)'\)/
const notAFunctionErrorPattern =
	/(?<![\w$.])([\w$]+(?:\.[\w$]+)*) is not a function/

const unboundRuntimeHelperMessagePattern =
	/The optional kody:runtime export "([\w$]+)" is not bound in this execution context/
const lateBoundUnavailableExportPattern =
	/kody:runtime export "([\w$]+)" is not available in this execution context/

export function createUnboundRuntimeHelperMessage(input: {
	originalMessage: string
	helperName: string
	reference: string
}) {
	const separator = /[.!?]\s*$/.test(input.originalMessage) ? ' ' : '. '
	// Attribution is a source-text heuristic (sandbox errors carry no stack),
	// so name the matching access without asserting it is the thrower.
	return (
		`${input.originalMessage}${separator}` +
		`The optional kody:runtime export "${input.helperName}" is not bound in this execution context, ` +
		`which likely caused \`${input.reference}\` to fail.`
	)
}

export function parseUnboundRuntimeHelperMessage(message: string) {
	return (
		unboundRuntimeHelperMessagePattern.exec(message)?.[1] ??
		lateBoundUnavailableExportPattern.exec(message)?.[1] ??
		null
	)
}

/**
 * Remedies for guard-less access to an optional `kody:runtime` export that
 * the execution context intentionally left unbound (`undefined` / `null` so
 * `if (email) { ... }` guards stay falsy). Execute attaches these as
 * structured `nextStep` values via `getExecutionErrorDetails`; package-app
 * hosts append the packages entry into the thrown / run-record message
 * because that path has no structured nextStep channel.
 */
export const unboundRuntimeHelperNextSteps: Readonly<Record<string, string>> = {
	packages:
		'`packages` is always unbound. Use a static `kody:@scope/package/export` import when the name is known, or `import(specifier)` when the name is data. Exactly-once work uses workflows.',
	events:
		'`events` is only bound in saved-package runtime contexts that can dispatch package events (package jobs, subscription handlers, and package apps). Ad hoc execute — including a statically imported package export — leaves events unbound; emit from a package job or guard with `if (events) { ... }`.',
	packageSecrets:
		"`packageSecrets` is bound on stamped saved-package modules (including static `kody:@` imports) and in saved-package runtime contexts. Ad hoc execute entry code stays unbound; import the owning package's export so its stamp reads the mounts, or guard with `'get' in packageSecrets` / `packageContext?.packageId` (the late-bound export is always a proxy).",
	email:
		'`email` is only bound for email-triggered runs; guard with `if (email) { ... }` when the code can also run outside an email context.',
}

export function buildUnboundRuntimeHelperNextStep(helperName: string) {
	const mapped = Object.hasOwn(unboundRuntimeHelperNextSteps, helperName)
		? unboundRuntimeHelperNextSteps[helperName]
		: undefined
	return (
		mapped ??
		`The optional \`${helperName}\` export of 'kody:runtime' is not provided in this execution context; guard with a falsiness check (for example \`if (${helperName}) { ... }\`) or run the code in a context that binds it, such as statically importing the owning saved package's export.`
	)
}

const nullPackagesInvokePropertyPattern =
	/Cannot read properties of null \(reading 'invoke'\)/

const packagesUnboundHelperNames = new Set(['packages'])

/**
 * True when the module graph contains a guard-less `packages.invoke` access
 * that can produce a null-property TypeError. Same source heuristic execute
 * uses via `findUnboundRuntimeHelperAccess` — do not rewrite from the bare
 * TypeError text alone (unrelated `null.invoke` must stay unhinted).
 */
export function modulesContainUnboundPackagesInvokeAccess(
	modules: WorkerLoaderModules,
) {
	return (
		findUnboundRuntimeHelperAccess({
			errorMessage: "Cannot read properties of null (reading 'invoke')",
			modules,
			unboundHelperNames: packagesUnboundHelperNames,
		})?.helperName === 'packages'
	)
}

/**
 * Package-app workers always bind `packages: null` so leftover
 * `if (packages)` guards stay falsy. Guard-less `packages.invoke` therefore
 * throws a bare null-property TypeError with no migration hint. Rewrite that
 * shape to the same unbound-helper message + packages nextStep execute uses,
 * without making `packages` truthy. Requires module-graph evidence that the
 * access is the unbound `packages` helper (not any null `.invoke`).
 */
export function rewriteNullPackagesInvokeErrorMessage(input: {
	originalMessage: string
	modules: WorkerLoaderModules
}): string | null {
	if (!nullPackagesInvokePropertyPattern.test(input.originalMessage)) {
		return null
	}
	if (!modulesContainUnboundPackagesInvokeAccess(input.modules)) return null
	const packagesNextStep = buildUnboundRuntimeHelperNextStep('packages')
	if (input.originalMessage.includes(packagesNextStep)) return null
	const unboundHelper =
		parseUnboundRuntimeHelperMessage(input.originalMessage) === 'packages'
			? input.originalMessage
			: createUnboundRuntimeHelperMessage({
					originalMessage: input.originalMessage,
					helperName: 'packages',
					reference: 'packages.invoke',
				})
	const separator = /[.!?]\s*$/.test(unboundHelper) ? ' ' : '. '
	return `${unboundHelper}${separator}${packagesNextStep}`
}

/**
 * Self-contained package-app host helpers that mirror
 * `rewriteNullPackagesInvokeErrorMessage` for fetch/realtime catch paths
 * (generated workers cannot import TypeScript modules). `enabled` is precomputed
 * at worker build from the hydrated module graph via
 * `modulesContainUnboundPackagesInvokeAccess`.
 */
export function createNullPackagesInvokeRewriteHostSource(input: {
	enabled: boolean
}) {
	const packagesNextStep = buildUnboundRuntimeHelperNextStep('packages')
	const unboundHelperSuffix =
		'The optional kody:runtime export "packages" is not bound in this execution context, which likely caused `packages.invoke` to fail.'
	return `
const __kodyRewriteNullPackagesInvoke = ${input.enabled ? 'true' : 'false'};
const __kodyPackagesUnboundNextStep = ${JSON.stringify(packagesNextStep)};
const __kodyPackagesUnboundHelperSuffix = ${JSON.stringify(unboundHelperSuffix)};
function rewriteNullPackagesInvokeErrorMessage(originalMessage) {
	if (!__kodyRewriteNullPackagesInvoke) return null;
	if (
		!/Cannot read properties of null \\(reading 'invoke'\\)/.test(
			originalMessage,
		)
	) {
		return null;
	}
	if (originalMessage.includes(__kodyPackagesUnboundNextStep)) return null;
	let unboundHelper = originalMessage;
	if (
		!/The optional kody:runtime export "packages" is not bound in this execution context/.test(
			originalMessage,
		)
	) {
		const helperSeparator = /[.!?]\\s*$/.test(originalMessage) ? ' ' : '. ';
		unboundHelper =
			originalMessage + helperSeparator + __kodyPackagesUnboundHelperSuffix;
	}
	const nextStepSeparator = /[.!?]\\s*$/.test(unboundHelper) ? ' ' : '. ';
	return unboundHelper + nextStepSeparator + __kodyPackagesUnboundNextStep;
}
function enrichUnboundPackagesInvokeError(error) {
	const originalMessage =
		error && typeof error.message === 'string'
			? error.message
			: String(error);
	const rewrittenMessage =
		rewriteNullPackagesInvokeErrorMessage(originalMessage);
	if (!rewrittenMessage) return error;
	const enriched = new Error(rewrittenMessage);
	enriched.name =
		error && typeof error.name === 'string' ? error.name : 'Error';
	if (error && typeof error.stack === 'string') {
		enriched.stack = error.stack.replace(originalMessage, rewrittenMessage);
	}
	return enriched;
}
`.trim()
}

/**
 * Matches a sandbox TypeError against the bundle's `kody:runtime` imports.
 * Returns the unbound optional helper whose guard-less access most plausibly
 * produced the error, or `null` when the error does not look like an
 * unbound-helper access (an ordinary user-code bug keeps its bare message).
 */
export function findUnboundRuntimeHelperAccess(input: {
	errorMessage: string
	modules: WorkerLoaderModules
	unboundHelperNames: ReadonlySet<string>
}): UnboundRuntimeHelperAccess | null {
	if (input.unboundHelperNames.size === 0) return null
	const lateBoundExport = lateBoundUnavailableExportPattern.exec(
		input.errorMessage,
	)?.[1]
	if (lateBoundExport && input.unboundHelperNames.has(lateBoundExport)) {
		return {
			helperName: lateBoundExport,
			reference: lateBoundExport,
		}
	}
	const propertyName =
		propertyReadErrorPattern.exec(input.errorMessage)?.[1] ?? null
	const calledExpression = propertyName
		? null
		: (notAFunctionErrorPattern.exec(input.errorMessage)?.[1] ?? null)
	if (propertyName == null && calledExpression == null) return null
	for (const source of iterateModuleSourceTexts(input.modules)) {
		const bindings = collectRuntimeImportBindings(source)
		if (bindings.length === 0) continue
		const match = propertyName
			? findPropertyReadAccess({
					source,
					bindings,
					propertyName,
					unboundHelperNames: input.unboundHelperNames,
				})
			: findCalledHelperAccess({
					calledExpression: calledExpression ?? '',
					bindings,
					unboundHelperNames: input.unboundHelperNames,
				})
		if (match) return match
	}
	return null
}

function findPropertyReadAccess(input: {
	source: string
	bindings: Array<RuntimeImportBinding>
	propertyName: string
	unboundHelperNames: ReadonlySet<string>
}): UnboundRuntimeHelperAccess | null {
	for (const binding of input.bindings) {
		if (binding.kind === 'named') {
			if (!input.unboundHelperNames.has(binding.helperName)) continue
			if (
				sourceContainsMemberAccess(input.source, [
					binding.localName,
					input.propertyName,
				])
			) {
				return {
					helperName: binding.helperName,
					reference: `${binding.helperName}.${input.propertyName}`,
				}
			}
			continue
		}
		for (const helperName of input.unboundHelperNames) {
			if (
				sourceContainsMemberAccess(input.source, [
					binding.localName,
					helperName,
					input.propertyName,
				])
			) {
				return {
					helperName,
					reference: `${helperName}.${input.propertyName}`,
				}
			}
		}
	}
	return null
}

function findCalledHelperAccess(input: {
	calledExpression: string
	bindings: Array<RuntimeImportBinding>
	unboundHelperNames: ReadonlySet<string>
}): UnboundRuntimeHelperAccess | null {
	const parts = input.calledExpression.split('.')
	for (const binding of input.bindings) {
		if (binding.kind === 'named') {
			if (!input.unboundHelperNames.has(binding.helperName)) continue
			if (parts.length === 1 && parts[0] === binding.localName) {
				return {
					helperName: binding.helperName,
					reference: binding.helperName,
				}
			}
			continue
		}
		if (parts.length !== 2 || parts[0] !== binding.localName) continue
		const helperName = parts[1] ?? ''
		if (input.unboundHelperNames.has(helperName)) {
			return { helperName, reference: helperName }
		}
	}
	return null
}

function sourceContainsMemberAccess(source: string, memberPath: Array<string>) {
	// `?.` optional chaining short-circuits instead of throwing, so only a
	// plain `.` access can have produced the TypeError being matched.
	const pattern = new RegExp(
		`(?<![\\w$.])${memberPath.map(escapeRegExp).join('\\s*\\.\\s*')}(?![\\w$])`,
	)
	return pattern.test(source)
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function collectRuntimeImportBindings(
	source: string,
): Array<RuntimeImportBinding> {
	if (
		!source.includes('kody:runtime') &&
		!source.includes('runtime.js') &&
		!source.includes('__kodyOptionalRuntime')
	) {
		return []
	}
	let program: unknown
	try {
		program = parseModuleSource(source)
	} catch {
		return []
	}
	const bindings: Array<RuntimeImportBinding> = []
	for (const node of readProgramBody(program)) {
		collectInlinedRuntimeBindings(node, bindings)
		if (readNodeType(node) !== 'ImportDeclaration') continue
		if (readRecordValue(node, 'importKind') === 'type') continue
		const specifier = readImportSourceValue(node)
		if (specifier == null || !isRuntimeModuleSpecifier(specifier)) continue
		for (const importSpecifier of readImportSpecifiers(node)) {
			const localName = readIdentifierName(
				readRecordValue(importSpecifier, 'local'),
			)
			if (!localName) continue
			const specifierType = readNodeType(importSpecifier)
			if (specifierType === 'ImportSpecifier') {
				if (readRecordValue(importSpecifier, 'importKind') === 'type') continue
				const importedName =
					readIdentifierName(readRecordValue(importSpecifier, 'imported')) ??
					readImportedStringName(readRecordValue(importSpecifier, 'imported'))
				if (!importedName) continue
				bindings.push({
					kind: 'named',
					helperName: importedName,
					localName,
				})
				continue
			}
			if (
				specifierType === 'ImportDefaultSpecifier' ||
				specifierType === 'ImportNamespaceSpecifier'
			) {
				// The default export mirrors the named exports, so member access
				// through either binding behaves like a namespace access.
				bindings.push({ kind: 'namespace', localName })
			}
		}
	}
	return bindings
}

const inlinedRuntimeExportFactoryNames = new Set([
	'__kodyOptionalRuntimeObjectExport',
	'__kodyOptionalRuntimeFunctionExport',
])

/**
 * Bundlers can inline the virtual runtime module into the entry module, so
 * helpers appear as plain top-level declarations instead of imports:
 * `var storage = __kodyOptionalRuntimeObjectExport("storage", void 0);`.
 * Collect those as named bindings so inlined bundles match too.
 */
function collectInlinedRuntimeBindings(
	node: unknown,
	bindings: Array<RuntimeImportBinding>,
) {
	if (readNodeType(node) !== 'VariableDeclaration') return
	const declarations = readRecordValue(node, 'declarations')
	if (!Array.isArray(declarations)) return
	for (const declaration of declarations) {
		if (readNodeType(declaration) !== 'VariableDeclarator') continue
		const localName = readIdentifierName(readRecordValue(declaration, 'id'))
		if (!localName) continue
		const init = readRecordValue(declaration, 'init')
		if (readNodeType(init) !== 'CallExpression') continue
		const calleeName = readIdentifierName(readRecordValue(init, 'callee'))
		if (!calleeName || !inlinedRuntimeExportFactoryNames.has(calleeName)) {
			continue
		}
		const callArguments = readRecordValue(init, 'arguments')
		const helperName = Array.isArray(callArguments)
			? readImportedStringName(callArguments[0])
			: null
		if (!helperName) continue
		bindings.push({ kind: 'named', helperName, localName })
	}
}

function isRuntimeModuleSpecifier(specifier: string) {
	if (specifier === 'kody:runtime') return true
	// Bundled module graphs rewrite `kody:runtime` to a relative path of the
	// virtual runtime module (see `rewriteKodyImports` in `module-graph.ts`).
	const modulePath = specifier.replace(/^(\.\.?\/)+/, '')
	return (
		isKodyRuntimeModulePath(modulePath) ||
		isKodyPublicRuntimeModulePath(modulePath)
	)
}

function* iterateModuleSourceTexts(
	modules: WorkerLoaderModules,
): Generator<string> {
	for (const module of Object.values(modules)) {
		if (typeof module === 'string') {
			yield module
			continue
		}
		if (typeof module.js === 'string') yield module.js
		if (typeof module.cjs === 'string') yield module.cjs
	}
}

function readProgramBody(program: unknown): Array<unknown> {
	if (program == null || typeof program !== 'object') return []
	const programNode = readRecordValue(program, 'program') ?? program
	const body = readRecordValue(programNode, 'body')
	return Array.isArray(body) ? body : []
}

function readNodeType(node: unknown) {
	const type = readRecordValue(node, 'type')
	return typeof type === 'string' ? type : null
}

function readRecordValue(node: unknown, key: string): unknown {
	if (node == null || typeof node !== 'object') return undefined
	return (node as Record<string, unknown>)[key]
}

function readImportSourceValue(node: unknown) {
	const value = readRecordValue(readRecordValue(node, 'source'), 'value')
	return typeof value === 'string' ? value : null
}

function readImportSpecifiers(node: unknown): Array<unknown> {
	const specifiers = readRecordValue(node, 'specifiers')
	return Array.isArray(specifiers) ? specifiers : []
}

function readIdentifierName(node: unknown) {
	if (readNodeType(node) !== 'Identifier') return null
	const name = readRecordValue(node, 'name')
	return typeof name === 'string' ? name : null
}

function readImportedStringName(node: unknown) {
	const nodeType = readNodeType(node)
	if (nodeType !== 'StringLiteral' && nodeType !== 'Literal') return null
	const value = readRecordValue(node, 'value')
	return typeof value === 'string' ? value : null
}
