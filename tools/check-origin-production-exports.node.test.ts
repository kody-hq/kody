import { expect, test } from 'vitest'
import {
	checkOriginProductionExports,
	extractNamedExports,
	hasExportStarDeclaration,
} from './check-origin-production-exports.ts'

const configPath = 'packages/worker/wrangler.jsonc'

const platformMailbox = {
	name: 'MAILBOX',
	class_name: 'Mailbox',
	script_name: 'kody-platform',
}

type ConfigOverrides = {
	productionDurableObjects?: Array<Record<string, unknown>>
	productionMain?: string
	previewMain?: unknown
	testMain?: unknown
	topLevelMain?: unknown
	testDurableObjects?: Array<Record<string, unknown>>
	previewDurableObjects?: Array<Record<string, unknown>>
}

function createConfig(overrides: ConfigOverrides) {
	const withMain = (section: Record<string, unknown>, main: unknown) =>
		main === undefined ? section : { ...section, main }
	return {
		main: overrides.topLevelMain ?? './src/index.ts',
		env: {
			production: withMain(
				{
					durable_objects: {
						bindings: overrides.productionDurableObjects ?? [platformMailbox],
					},
				},
				overrides.productionMain,
			),
			preview: withMain(
				{
					durable_objects: {
						bindings: overrides.previewDurableObjects ?? [platformMailbox],
					},
				},
				overrides.previewMain,
			),
			test: withMain(
				{
					durable_objects: {
						bindings: overrides.testDurableObjects ?? [
							{ name: 'MAILBOX', class_name: 'Mailbox' },
						],
					},
				},
				overrides.testMain,
			),
		},
	}
}

function entry(...names: Array<string>) {
	return `\nexport { ${names.join(', ')} }\nexport default originWorkerHandler\n`
}

const devEntrySource = entry(
	'Mailbox',
	'KodyFetchGateway',
	'DynamicWorkerUsageTail',
	'JobsHost',
	'KodyApi',
)
const productionEntrySource = entry(
	'KodyFetchGateway',
	'DynamicWorkerUsageTail',
	'JobsHost',
	'KodyApi',
)

test('the origin export guardrail accepts the dev/test/preview split and rejects each drift', () => {
	const cases: Array<{
		scenario: string
		config?: ConfigOverrides
		dev?: string
		production?: string
		error?: string
	}> = [
		{ scenario: 'accepts the checked-in production/dev-test-preview split' },
		{
			scenario:
				'rejects a production Durable Object binding without script_name',
			config: {
				productionDurableObjects: [{ name: 'MAILBOX', class_name: 'Mailbox' }],
			},
			error: 'env.production binds "Mailbox" without a script_name',
		},
		{
			scenario:
				'rejects the production entry exporting a class outside the allowlist',
			production: entry(
				'Mailbox',
				'KodyFetchGateway',
				'DynamicWorkerUsageTail',
				'JobsHost',
				'KodyApi',
			),
			error:
				'must export exactly DynamicWorkerUsageTail, JobsHost, KodyApi, KodyFetchGateway (unexpected Mailbox)',
		},
		{
			scenario: 'rejects the production entry missing an allowlisted export',
			production: entry(
				'KodyFetchGateway',
				'DynamicWorkerUsageTail',
				'KodyApi',
			),
			error:
				'must export exactly DynamicWorkerUsageTail, JobsHost, KodyApi, KodyFetchGateway (missing JobsHost)',
		},
		{
			scenario: 'rejects a dev entry missing a class env.test owns locally',
			dev: entry('KodyFetchGateway', 'JobsHost'),
			error: 'does not export "Mailbox"',
		},
		// Preview uploads the same slim entry as production
		// (tools/ci/preview-resources.ts), so a locally-owned preview binding
		// would need a class the slim entry does not export.
		{
			scenario: 'rejects a preview Durable Object binding without script_name',
			config: {
				previewDurableObjects: [
					{ name: 'STORAGE_RUNNER', class_name: 'StorageRunner' },
				],
			},
			dev: entry('Mailbox', 'StorageRunner', 'KodyFetchGateway', 'JobsHost'),
			error: 'env.preview binds "StorageRunner" without a script_name',
		},
		{
			scenario:
				'does not require the dev entry to export a class env.preview only binds cross-script',
			config: {
				testDurableObjects: [],
				previewDurableObjects: [
					{
						name: 'STORAGE_RUNNER',
						class_name: 'StorageRunner',
						script_name: 'kody-runtime',
					},
				],
			},
			dev: entry('KodyFetchGateway', 'JobsHost'),
		},
		{
			scenario: 'rejects env.preview overriding main',
			config: { previewMain: './src/production-worker.ts' },
			error: 'env.preview.main is set',
		},
		{
			scenario: 'rejects env.test overriding main',
			config: { testMain: './src/production-worker.ts' },
			error: 'env.test.main is set',
		},
		{
			scenario:
				'rejects a top-level main that does not match the expected dev entry',
			config: { topLevelMain: './src/other.ts' },
			error: 'top-level "main" is "./src/other.ts"',
		},
		{
			scenario:
				'rejects a committed env.production.main because the slim entry is deploy-generated only',
			config: { productionMain: './src/production-worker.ts' },
			error: 'env.production.main is set ("./src/production-worker.ts")',
		},
		...[
			'export * from "./index.ts"',
			'export * as Legacy from "./index.ts"',
		].map((star) => ({
			scenario: `rejects a production entry that hides runtime names behind ${star}`,
			production: `${productionEntrySource}${star}\n`,
			error: 'must not use export *',
		})),
	]
	const results = cases.map(({ scenario, config, dev, production }) => ({
		scenario,
		result: checkOriginProductionExports({
			configPath,
			config: createConfig(config ?? {}),
			devEntrySource: dev ?? devEntrySource,
			productionEntrySource: production ?? productionEntrySource,
		}),
	}))
	expect(results).toEqual(
		cases.map(({ scenario, error }) => ({
			scenario,
			result: error
				? { ok: false, errors: [expect.stringContaining(error)] }
				: { ok: true, errors: [] },
		})),
	)
})

test('extractNamedExports reads runtime names from the TypeScript AST only', () => {
	const cases: Array<[string, unknown]> = [
		[
			`
export { A, B as C }
export const D = 1
export class E {}
export function f() {}
export default E
`,
			expect.arrayContaining(['A', 'C', 'D', 'E', 'f']),
		],
		['export default handler', []],
		[
			`
export type { TypeOnlyName }
export { type TypeOnlySpecifier, RuntimeName }
export { JobsHost }
`,
			['RuntimeName', 'JobsHost'],
		],
		['export default class JobsHost {}', []],
		['export declare class JobsHost {}', []],
		['export class JobsHost {}', ['JobsHost']],
		[
			`
// export { ShouldNotCount }
/**
 * export { AlsoShouldNotCount }
 */
const trap = 'export { StillNotReal }'
const template = \`export { NeitherIsThis }\`
export { RealExport }
`,
			['RealExport'],
		],
	]
	expect(
		cases.map(([source]) => [source, extractNamedExports(source)]),
	).toEqual(cases)
})

test('hasExportStarDeclaration detects runtime export-star and ignores type-only stars', () => {
	const cases: Array<[string, boolean]> = [
		['export * from "./index.ts"', true],
		['export * as Legacy from "./index.ts"', true],
		['export type * from "./types.ts"', false],
		['export { JobsHost }', false],
	]
	expect(
		cases.filter(([source, want]) => hasExportStarDeclaration(source) !== want),
	).toEqual([])
})
