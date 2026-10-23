import { expect, test } from 'vitest'
import {
	createNullPackagesInvokeRewriteHostSource,
	createUnboundRuntimeHelperMessage,
	findUnboundRuntimeHelperAccess,
	modulesContainUnboundPackagesInvokeAccess,
	parseUnboundRuntimeHelperMessage,
	rewriteNullPackagesInvokeErrorMessage,
} from './unbound-runtime-helpers.ts'

const allOptionalHelperNames = new Set([
	'storage',
	'createAuthenticatedFetch',
	'secretHeaders',
	'oauthClientCredentials',
	'packageSecrets',
	'email',
	'workflows',
	'packages',
	'events',
])

const readSql = "Cannot read properties of undefined (reading 'sql')"
const packageSecretsUnavailable =
	'kody:runtime export "packageSecrets" is not available in this execution context.'
const storageEntry = {
	'entry.js': `import { storage } from 'kody:runtime'
export default async () => (await storage.sql('select 1')).rows`,
}
const packageSecretsEntry = {
	'entry.js': `import { packageSecrets } from 'kody:runtime'
export default async () => await packageSecrets.get('token')`,
}

// Real bundles inline the virtual runtime module into the entry module,
// so helpers are top-level declarations rather than import bindings.
const inlinedBundle = {
	'bundle.js': `var storage = __kodyOptionalRuntimeObjectExport("storage", void 0);
var createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");
async function main() {
	const result = await storage.sql("select 1");
	return result.rows;
}`,
}

type Modules = Parameters<typeof findUnboundRuntimeHelperAccess>[0]['modules']

function find(
	errorMessage: string,
	modules: Modules,
	unboundHelperNames = allOptionalHelperNames,
) {
	return findUnboundRuntimeHelperAccess({
		errorMessage,
		modules,
		unboundHelperNames,
	})
}

test('findUnboundRuntimeHelperAccess matches guard-less reads, calls, aliases, namespaces, and inlined helpers', () => {
	const cases: Array<[string, Modules, string, string]> = [
		[readSql, storageEntry, 'storage', 'storage.sql'],
		// Helpers with a `null` absent value fail the same way.
		[
			"TypeError: Cannot read properties of null (reading 'getMessage')",
			{
				'entry.js': `import { email } from 'kody:runtime'
export default async () => await email.getMessage('m-1')`,
			},
			'email',
			'email.getMessage',
		],
		// Bundled saved-package modules import the virtual runtime module through
		// a rewritten relative path and may alias the binding.
		[
			readSql,
			{
				'entry.js': {
					js: `import { storage as db } from '../.__kody_virtual__/runtime.js'
export default async () => (await db.sql('select 1')).rows`,
				},
			},
			'storage',
			'storage.sql',
		],
		[
			readSql,
			{
				'entry.js': `import * as runtime from 'kody:runtime'
export default async () => await runtime.storage.sql('select 1')`,
			},
			'storage',
			'storage.sql',
		],
		[readSql, inlinedBundle, 'storage', 'storage.sql'],
		[
			'createAuthenticatedFetch is not a function',
			inlinedBundle,
			'createAuthenticatedFetch',
			'createAuthenticatedFetch',
		],
		[
			'TypeError: createAuthenticatedFetch is not a function',
			{
				'entry.js': `import { createAuthenticatedFetch } from 'kody:runtime'
export default async () => await createAuthenticatedFetch('google-personal')`,
			},
			'createAuthenticatedFetch',
			'createAuthenticatedFetch',
		],
		[
			'runtime.oauthClientCredentials is not a function',
			{
				'entry.js': `import * as runtime from 'kody:runtime'
export default async () => await runtime.oauthClientCredentials({})`,
			},
			'oauthClientCredentials',
			'oauthClientCredentials',
		],
		// Late-bound optional exports (packageSecrets) throw this instead of a
		// null-property TypeError when the evaluate store omits the helper.
		[
			packageSecretsUnavailable,
			packageSecretsEntry,
			'packageSecrets',
			'packageSecrets',
		],
	]
	for (const [errorMessage, modules, helperName, reference] of cases) {
		expect(find(errorMessage, modules)).toEqual({ helperName, reference })
	}
})

test('findUnboundRuntimeHelperAccess leaves unrelated errors and bound helpers unhinted', () => {
	const cases: Array<[string, Modules, Set<string>?]> = [
		// The helper is bound in this run, so the TypeError is a user-code bug.
		[readSql, storageEntry, new Set(['email'])],
		[packageSecretsUnavailable, packageSecretsEntry, new Set(['email'])],
		// The failed property read does not appear on any runtime helper binding.
		["Cannot read properties of undefined (reading 'rows')", storageEntry],
		// Optional chaining short-circuits instead of throwing, so guarded access
		// must not be treated as the source of the TypeError.
		[
			readSql,
			{
				'entry.js': `import { storage } from 'kody:runtime'
export default async () => (await storage?.sql('select 1')) ?? null`,
			},
		],
		// A same-named binding from another module is not a runtime helper.
		[
			readSql,
			{
				'entry.js': `import { storage } from './my-storage.js'
export default async () => (await storage.sql('select 1')).rows`,
			},
		],
		// A declaration initialized by an unrelated factory is not a helper.
		[
			readSql,
			{
				'bundle.js': `var storage = createMyStorage("storage");
async function main() { return (await storage.sql("select 1")).rows }`,
			},
		],
		['Execution timed out', storageEntry],
	]
	for (const [errorMessage, modules, unboundHelperNames] of cases) {
		expect(find(errorMessage, modules, unboundHelperNames)).toBeNull()
	}
})

test('createUnboundRuntimeHelperMessage round-trips through parseUnboundRuntimeHelperMessage', () => {
	const message = createUnboundRuntimeHelperMessage({
		originalMessage: readSql,
		helperName: 'storage',
		reference: 'storage.sql',
	})
	expect(message).toContain(readSql)
	for (const [input, expected] of [
		[message, 'storage'],
		// Wrapped transports (for example package invocation responses) prefix
		// the message; parsing must stay prefix-tolerant.
		[`[execution_failed] ${message}`, 'storage'],
		[readSql, null],
		[packageSecretsUnavailable, 'packageSecrets'],
	] as const) {
		expect(parseUnboundRuntimeHelperMessage(input)).toBe(expected)
	}
})

test('rewriteNullPackagesInvokeErrorMessage requires packages.invoke source evidence', () => {
	const bare = "Cannot read properties of null (reading 'invoke')"
	const packagesInvokeModules = {
		'entry.js': `import { packages } from 'kody:runtime'
export default async () => await packages.invoke('kody:@owner/pkg/export', { params: {} })`,
	}
	const unrelatedInvokeModules = {
		'entry.js': `export default async () => {
	const client = null
	return client.invoke()
}`,
	}
	const rewritten = rewriteNullPackagesInvokeErrorMessage({
		originalMessage: bare,
		modules: packagesInvokeModules,
	})
	expect(rewritten).toContain(bare)
	expect(parseUnboundRuntimeHelperMessage(rewritten ?? '')).toBe('packages')
	expect(rewritten).toContain('packages.invoke')
	expect(
		rewriteNullPackagesInvokeErrorMessage({
			originalMessage: rewritten ?? '',
			modules: packagesInvokeModules,
		}),
	).toBeNull()
	expect(
		rewriteNullPackagesInvokeErrorMessage({
			originalMessage: bare,
			modules: unrelatedInvokeModules,
		}),
	).toBeNull()
	expect(
		rewriteNullPackagesInvokeErrorMessage({
			originalMessage: "Cannot read properties of null (reading 'getMessage')",
			modules: packagesInvokeModules,
		}),
	).toBeNull()
	expect(modulesContainUnboundPackagesInvokeAccess(packagesInvokeModules)).toBe(
		true,
	)
	expect(
		modulesContainUnboundPackagesInvokeAccess(unrelatedInvokeModules),
	).toBe(false)
})

test('createNullPackagesInvokeRewriteHostSource mirrors rewrite when enabled', () => {
	const packagesInvokeModules = {
		'entry.js': `import { packages } from 'kody:runtime'
export default async () => await packages.invoke('kody:@owner/pkg/export', { params: {} })`,
	}
	const hostSource = createNullPackagesInvokeRewriteHostSource({
		enabled: modulesContainUnboundPackagesInvokeAccess(packagesInvokeModules),
	})
	const runner = new Function(
		'exports',
		`${hostSource}\nexports.rewrite = rewriteNullPackagesInvokeErrorMessage;\nexports.enrich = enrichUnboundPackagesInvokeError;`,
	)
	const exports: {
		rewrite?: (message: string) => string | null
		enrich?: (error: unknown) => Error
	} = {}
	runner(exports)
	const bare = "Cannot read properties of null (reading 'invoke')"
	const rewritten = exports.rewrite?.(bare) ?? ''
	expect(parseUnboundRuntimeHelperMessage(rewritten)).toBe('packages')
	expect(rewritten).toContain(bare)
	expect(rewritten).toContain('packages.invoke')
	const enriched = exports.enrich?.(new TypeError(bare))
	expect(enriched).toBeInstanceOf(Error)
	expect(parseUnboundRuntimeHelperMessage(enriched?.message ?? '')).toBe(
		'packages',
	)
	expect(enriched?.message).toContain(bare)
	const disabledHost = createNullPackagesInvokeRewriteHostSource({
		enabled: false,
	})
	const disabledExports: {
		rewrite?: (message: string) => string | null
	} = {}
	new Function(
		'exports',
		`${disabledHost}\nexports.rewrite = rewriteNullPackagesInvokeErrorMessage;`,
	)(disabledExports)
	expect(disabledExports.rewrite?.(bare)).toBeNull()
})
