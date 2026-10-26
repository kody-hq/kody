import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { parseJsonc } from './ci/resource-utils.ts'
import { isExecutedDirectly } from './node-runtime.ts'

export const defaultWranglerConfigPath = path.join(
	'packages',
	'worker',
	'wrangler.jsonc',
)
export const defaultDevEntryPath = './src/index.ts'
export const defaultProductionEntryPath = './src/production-worker.ts'

/**
 * The only `ctx.exports` WorkerEntrypoint contracts production actually
 * calls on its own script (see the doc comment on
 * `packages/worker/src/production-worker.ts`). Every other class
 * `index.ts` exports is reached in production only through a cross-script
 * binding (`script_name`) or the `RUNTIME_WORKER` service forward, so the
 * production entry must export exactly this set — nothing more, nothing
 * less.
 */
export const productionExportAllowlist = [
	'DynamicWorkerUsageTail',
	'JobsHost',
	'KodyApi',
	'KodyFetchGateway',
]

type WranglerConfig = {
	main?: unknown
	env?: unknown
	[key: string]: unknown
}

type ClassBinding = {
	class_name: string
	script_name?: string
}

export type OriginProductionExportsCheckResult = {
	ok: boolean
	errors: Array<string>
}

/**
 * Every top-level `export { A, B as C }` block, plus `export const/class/
 * function X` declarations. Parsed with the TypeScript compiler API (not
 * regex) so comments, string/template literals, and nested scopes that
 * merely *contain* export-shaped text (for example a docstring quoting
 * `export { Mailbox }`) can never be mistaken for a real export.
 */
export function extractNamedExports(source: string): Array<string> {
	const sourceFile = ts.createSourceFile(
		'origin-entry.ts',
		source,
		ts.ScriptTarget.Latest,
		false,
		ts.ScriptKind.TS,
	)
	const names = new Set<string>()

	const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
		ts.canHaveModifiers(node) &&
		ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true

	for (const statement of sourceFile.statements) {
		if (ts.isExportDeclaration(statement)) {
			if (statement.isTypeOnly) continue
			const clause = statement.exportClause
			if (clause && ts.isNamedExports(clause)) {
				for (const element of clause.elements) {
					if (element.isTypeOnly) continue
					names.add(element.name.text)
				}
			}
			continue
		}

		if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue
		if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) continue
		if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue

		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) {
					names.add(declaration.name.text)
				}
			}
			continue
		}

		if (
			(ts.isClassDeclaration(statement) ||
				ts.isFunctionDeclaration(statement)) &&
			statement.name
		) {
			names.add(statement.name.text)
		}
	}

	return [...names]
}

/**
 * `export * from "./module"` and `export * as ns from "./module"` forward
 * runtime names the production allowlist cannot see, so the checker
 * rejects them instead of treating the file as empty.
 */
export function hasExportStarDeclaration(source: string): boolean {
	const sourceFile = ts.createSourceFile(
		'origin-entry.ts',
		source,
		ts.ScriptTarget.Latest,
		false,
		ts.ScriptKind.TS,
	)
	return sourceFile.statements.some((statement) => {
		if (!ts.isExportDeclaration(statement)) return false
		if (statement.isTypeOnly) return false
		if (!statement.moduleSpecifier) return false
		return (
			statement.exportClause == null ||
			ts.isNamespaceExport(statement.exportClause)
		)
	})
}

function collectClassBindings(envConfig: unknown): Array<ClassBinding> {
	if (!envConfig || typeof envConfig !== 'object') return []
	const config = envConfig as Record<string, unknown>
	const bindings: Array<ClassBinding> = []

	const durableObjects = config.durable_objects
	if (durableObjects && typeof durableObjects === 'object') {
		const list = (durableObjects as Record<string, unknown>).bindings
		if (Array.isArray(list)) {
			for (const entry of list) {
				if (!entry || typeof entry !== 'object') continue
				const candidate = entry as Record<string, unknown>
				if (typeof candidate.class_name === 'string') {
					bindings.push({
						class_name: candidate.class_name,
						...(typeof candidate.script_name === 'string'
							? { script_name: candidate.script_name }
							: {}),
					})
				}
			}
		}
	}

	const workflows = config.workflows
	if (Array.isArray(workflows)) {
		for (const entry of workflows) {
			if (!entry || typeof entry !== 'object') continue
			const candidate = entry as Record<string, unknown>
			if (typeof candidate.class_name === 'string') {
				bindings.push({
					class_name: candidate.class_name,
					...(typeof candidate.script_name === 'string'
						? { script_name: candidate.script_name }
						: {}),
				})
			}
		}
	}

	return bindings
}

function classNamesOf(bindings: ReadonlyArray<ClassBinding>) {
	return [...new Set(bindings.map((binding) => binding.class_name))].sort()
}

/**
 * Guards the origin slim/full entry split (ADR 0034):
 *
 * - `env.production` and `env.preview` must bind every Durable Object/
 *   workflow class cross-script (`script_name`). Both environments deploy
 *   the slim `production-worker.ts` entry (generated by
 *   `tools/ci/production-resources.ts` / `preview-resources.ts`), so a
 *   binding without `script_name` would make that script locally own the
 *   class again, which requires exporting it from the slim entry.
 * - The slim entry must export exactly `productionExportAllowlist` — no
 *   more, no less. Its `main` override is deploy-generated only and is never
 *   required or checked here.
 * - The dev/test entry must export every class `env.test` binds locally
 *   (local dev, vitest-plugin, and Playwright own every class on one
 *   script). Any environment that binds a class without `script_name` is
 *   also covered, so a locally-owned binding in `env.preview` fails twice:
 *   once for the missing `script_name`, once if the dev entry lacks the
 *   class.
 * - No committed environment may override `main`. The slim entry is applied
 *   only to the generated deploy configs; local production-mode dev,
 *   preview, and test all inherit the top-level dev/test entry so historical
 *   `new_sqlite_classes` migrations can replay locally.
 */
export function checkOriginProductionExports(input: {
	configPath: string
	config: WranglerConfig
	devEntrySource: string
	productionEntrySource: string
	devEntryPath?: string
	productionEntryPath?: string
}): OriginProductionExportsCheckResult {
	const devEntryPath = input.devEntryPath ?? defaultDevEntryPath
	const productionEntryPath =
		input.productionEntryPath ?? defaultProductionEntryPath
	const errors: Array<string> = []

	const env = input.config.env
	if (!env || typeof env !== 'object') {
		return { ok: false, errors: [`${input.configPath}: missing "env".`] }
	}
	const envRecord = env as Record<string, unknown>
	const productionEnv = envRecord.production
	const testEnv = envRecord.test
	if (!productionEnv || typeof productionEnv !== 'object') {
		errors.push(`${input.configPath}: missing "env.production".`)
	}
	if (!testEnv || typeof testEnv !== 'object') {
		errors.push(`${input.configPath}: missing "env.test".`)
	}
	if (errors.length > 0) return { ok: false, errors }

	const previewEnv = envRecord.preview
	const slimEnvironments: Array<[name: string, env: unknown]> = [
		['production', productionEnv],
		['preview', previewEnv],
	]
	for (const [envName, slimEnv] of slimEnvironments) {
		for (const binding of collectClassBindings(slimEnv)) {
			if (!binding.script_name) {
				errors.push(
					`${input.configPath}: env.${envName} binds "${binding.class_name}" without a script_name, so the slim ${envName} origin would locally own this Durable Object/workflow class (ADR 0034 violation). Either add script_name (kody-platform or kody-runtime) or export the class from ${productionEntryPath}.`,
				)
			}
		}
	}

	const testBindings = collectClassBindings(testEnv)
	const previewBindings = collectClassBindings(previewEnv)
	// Every class env.test binds (locally, by design), plus any class another
	// environment binds without script_name — the dev/test entry must export
	// all of them.
	const requiredDevClassNames = classNamesOf([
		...testBindings,
		...previewBindings.filter((binding) => !binding.script_name),
	])

	const devExports = new Set(extractNamedExports(input.devEntrySource))
	const productionExportsList = extractNamedExports(input.productionEntrySource)
	const productionExports = new Set(productionExportsList)
	if (hasExportStarDeclaration(input.productionEntrySource)) {
		errors.push(
			`${productionEntryPath}: must not use export * or export * as (the production allowlist cannot see star-forwarded runtime names).`,
		)
	}

	for (const className of requiredDevClassNames) {
		if (!devExports.has(className)) {
			errors.push(
				`${devEntryPath}: does not export "${className}", but env.test (or another environment, without script_name) binds it in ${input.configPath}. The dev/test entry must export every locally-owned Durable Object/workflow class.`,
			)
		}
	}

	const allowlist = new Set(productionExportAllowlist)
	const missingAllowlisted = productionExportAllowlist.filter(
		(name) => !productionExports.has(name),
	)
	const unexpectedExports = productionExportsList
		.filter((name) => !allowlist.has(name))
		.sort()
	if (missingAllowlisted.length > 0 || unexpectedExports.length > 0) {
		const parts: Array<string> = []
		if (missingAllowlisted.length > 0) {
			parts.push(`missing ${missingAllowlisted.join(', ')}`)
		}
		if (unexpectedExports.length > 0) {
			parts.push(`unexpected ${unexpectedExports.join(', ')}`)
		}
		errors.push(
			`${productionEntryPath}: must export exactly ${productionExportAllowlist.join(', ')} (${parts.join('; ')}).`,
		)
	}

	const previewMain =
		previewEnv && typeof previewEnv === 'object'
			? (previewEnv as Record<string, unknown>).main
			: undefined
	if (previewMain !== undefined) {
		errors.push(
			`${input.configPath}: env.preview.main is set (${JSON.stringify(previewMain)}); the slim preview entry is deploy-generated only (tools/ci/preview-resources.ts) so env.preview must inherit the top-level "main" (${devEntryPath}).`,
		)
	}

	const productionMain = (productionEnv as Record<string, unknown>).main
	if (productionMain !== undefined) {
		errors.push(
			`${input.configPath}: env.production.main is set (${JSON.stringify(productionMain)}); the slim production entry is deploy-generated only (tools/ci/production-resources.ts) so local production-mode dev must inherit the top-level "main" (${devEntryPath}).`,
		)
	}

	const testMain = (testEnv as Record<string, unknown>).main
	if (testMain !== undefined) {
		errors.push(
			`${input.configPath}: env.test.main is set (${JSON.stringify(testMain)}); env.test must inherit the top-level "main" (${devEntryPath}) so local dev/test/e2e keeps owning every Durable Object class it declares.`,
		)
	}

	const topLevelMain = input.config.main
	if (topLevelMain !== devEntryPath) {
		errors.push(
			`${input.configPath}: top-level "main" is ${JSON.stringify(topLevelMain)}, expected ${JSON.stringify(devEntryPath)} (env.test and env.preview inherit it).`,
		)
	}

	return { ok: errors.length === 0, errors }
}

export async function checkOriginProductionExportsInRepo(options?: {
	configPath?: string
	devEntryPath?: string
	productionEntryPath?: string
}): Promise<OriginProductionExportsCheckResult> {
	const configPath = options?.configPath ?? defaultWranglerConfigPath
	const devEntryPath = options?.devEntryPath ?? defaultDevEntryPath
	const productionEntryPath =
		options?.productionEntryPath ?? defaultProductionEntryPath

	const workerDir = path.dirname(configPath)
	const [configSource, devEntrySource, productionEntrySource] =
		await Promise.all([
			readFile(configPath, 'utf8'),
			readFile(path.join(workerDir, devEntryPath), 'utf8'),
			readFile(path.join(workerDir, productionEntryPath), 'utf8'),
		])

	return checkOriginProductionExports({
		configPath,
		config: parseJsonc<WranglerConfig>(configSource),
		devEntrySource,
		productionEntrySource,
		devEntryPath,
		productionEntryPath,
	})
}

export async function main(): Promise<void> {
	const result = await checkOriginProductionExportsInRepo()
	if (!result.ok) {
		console.error(
			`Origin production export check failed (${String(result.errors.length)} issue(s)):`,
		)
		for (const error of result.errors) console.error(`  - ${error}`)
		process.exitCode = 1
		return
	}
	console.log(
		'Origin production export check ok: the slim entry exports exactly the allowlisted entrypoints, production and preview own zero local Durable Object/workflow classes, and the dev/test entry still exports every locally-owned class.',
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
