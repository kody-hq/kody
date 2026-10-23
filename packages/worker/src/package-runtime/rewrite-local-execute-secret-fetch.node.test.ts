import { expect, test } from 'vitest'
import {
	ensureLocalExecuteMeterStaticPackageExportImport,
	injectLocalExecuteGatewayFetchBinding,
	moduleSourceHasSecretPlaceholderLiterals,
	rewriteLocalExecuteModuleForSecretAwareFetch,
	rewriteLocalExecuteSecretPlaceholderLiterals,
} from './rewrite-local-execute-secret-fetch.ts'

test('rewriteLocalExecuteSecretPlaceholderLiterals removes resolvable template literals', () => {
	const source = `const token = '{{secret:demoToken|scope=user}}'
export async function request() {
  return fetch('https://api.example.com/v1', {
    headers: { authorization: 'Bearer ' + token },
  })
}`
	expect(moduleSourceHasSecretPlaceholderLiterals(source)).toBe(true)
	const rewritten = rewriteLocalExecuteSecretPlaceholderLiterals(source)
	expect(rewritten.rewritten).toBe(true)
	expect(rewritten.source).not.toContain('{{secret:demoToken|scope=user}}')
	expect(rewritten.source).toContain('__kodySecretRef("demoToken", "user")')
	expect(moduleSourceHasSecretPlaceholderLiterals(rewritten.source)).toBe(false)
})

test('rewriteLocalExecuteSecretPlaceholderLiterals leaves non-computed object keys alone', () => {
	const source = `const map = { '{{secret:demoToken|scope=user}}': true }
const value = '{{secret:demoToken|scope=user}}'
`
	const rewritten = rewriteLocalExecuteSecretPlaceholderLiterals(source)
	expect(rewritten.rewritten).toBe(true)
	expect(rewritten.source).toContain(
		"{ '{{secret:demoToken|scope=user}}': true }",
	)
	expect(rewritten.source).toContain('__kodySecretRef("demoToken", "user")')
})

test('rewriteLocalExecuteModuleForSecretAwareFetch binds gateway fetch and strips templates', () => {
	const source = `const SECRET = '{{secret:demoToken|scope=user}}'
export async function listSites() {
  return fetch('https://api.usefathom.com/v1/sites', {
    headers: { authorization: 'Bearer ' + SECRET },
  })
}`
	const rewritten = rewriteLocalExecuteModuleForSecretAwareFetch({
		modulePath:
			'.__kody_packages__/demo/.__published_bundle__/artifact/dist/index.js',
		source,
		primaryRuntimePath: '.__kody_virtual__/runtime.js',
		packageId: 'pkg-demo',
	})
	expect(rewritten.rewritten).toBe(true)
	expect(rewritten.source).not.toContain('{{secret:demoToken|scope=user}}')
	expect(rewritten.source).toContain('__kodySecretRef("demoToken", "user")')
	expect(rewritten.source).toContain('__kodyCreatePackageBoundGatewayFetch')
	expect(rewritten.source).toContain('"pkg-demo"')
	expect(rewritten.source).toMatch(
		/const fetch = __kodyCreatePackageBoundGatewayFetch/,
	)
})

test('injectLocalExecuteGatewayFetchBinding skips when fetch is already bound', () => {
	const source = `const fetch = globalThis.fetch;
const SECRET = '{{secret:demoToken|scope=user}}';
`
	const placeholders = rewriteLocalExecuteSecretPlaceholderLiterals(source)
	const injected = injectLocalExecuteGatewayFetchBinding({
		modulePath:
			'.__kody_packages__/demo/.__published_bundle__/artifact/dist/index.js',
		source: placeholders.source,
		primaryRuntimePath: '.__kody_virtual__/runtime.js',
		packageId: 'pkg-demo',
	})
	expect(injected.source).toContain('__kodySecretRef("demoToken", "user")')
	expect(injected.source).toContain('import { __kodySecretRef }')
	expect(injected.source).not.toContain('__kodyCreatePackageBoundGatewayFetch')
	expect(injected.source).toMatch(/const fetch = globalThis\.fetch/)
})

test('ensureLocalExecuteMeterStaticPackageExportImport binds free meter calls', () => {
	const mergeSource = `import {
	__kodySecretRef,
	__kodyCreatePackageBoundGatewayFetch,
} from "../../../../../.__kody_virtual__/runtime.js";
var fetch = __kodyCreatePackageBoundGatewayFetch("280d0259-20e7-4fbb-9e22-5a50728bcf65");
var editMessage = __kodyMeterStaticPackageExport("41095c29-4539-4f2f-a6fb-646348602c18", rawEdit);
export default async function advance() { return editMessage }
`
	const merged = ensureLocalExecuteMeterStaticPackageExportImport({
		modulePath:
			'.__kody_packages__/demo/.__published_bundle__/artifact/dist/index.js',
		source: mergeSource,
		primaryRuntimePath: '.__kody_virtual__/runtime.js',
	})
	expect(merged.rewritten).toBe(true)
	expect(merged.source).toMatch(
		/import\s*\{[^}]*__kodyMeterStaticPackageExport[^}]*\}\s*from\s*"\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.__kody_virtual__\/runtime\.js"/,
	)
	expect(merged.source.match(/__kodyMeterStaticPackageExport/g)?.length).toBe(2)

	const noMeter = `export default async function main() { return 1 }`
	expect(
		ensureLocalExecuteMeterStaticPackageExportImport({
			modulePath:
				'.__kody_packages__/demo/.__published_bundle__/artifact/dist/index.js',
			source: noMeter,
			primaryRuntimePath: '.__kody_virtual__/runtime.js',
		}),
	).toEqual({ source: noMeter, rewritten: false })

	const aliased = `import { __kodyMeterStaticPackageExport as meter } from "../../../../../.__kody_virtual__/runtime.js";
var editMessage = __kodyMeterStaticPackageExport("pkg-discord", rawEdit);
export default editMessage;
`
	const besideAlias = ensureLocalExecuteMeterStaticPackageExportImport({
		modulePath:
			'.__kody_packages__/demo/.__published_bundle__/artifact/dist/index.js',
		source: aliased,
		primaryRuntimePath: '.__kody_virtual__/runtime.js',
	})
	expect(besideAlias.rewritten).toBe(true)
	expect(besideAlias.source).toContain(
		'__kodyMeterStaticPackageExport as meter',
	)
	expect(besideAlias.source).toMatch(
		/import\s*\{\s*__kodyMeterStaticPackageExport\s*,/,
	)

	const alreadyBound = `import { __kodyMeterStaticPackageExport } from "../../.__kody_virtual__/runtime.js";
var editMessage = __kodyMeterStaticPackageExport("pkg-discord", rawEdit);
export default editMessage;
`
	expect(
		ensureLocalExecuteMeterStaticPackageExportImport({
			modulePath:
				'.__kody_packages__/demo/.__published_bundle__/artifact/dist/index.js',
			source: alreadyBound,
			primaryRuntimePath: '.__kody_virtual__/runtime.js',
		}),
	).toEqual({ source: alreadyBound, rewritten: false })
})
