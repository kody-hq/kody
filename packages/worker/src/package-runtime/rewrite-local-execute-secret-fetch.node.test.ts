import path from 'node:path'
import { expect, test } from 'vitest'
import {
	ensureLocalExecuteMeterStaticPackageExportImport,
	injectLocalExecuteGatewayFetchBinding,
	rewriteLocalExecuteModuleForSecretAwareFetch,
	rewriteLocalExecuteSecretPlaceholderLiterals,
} from './rewrite-local-execute-secret-fetch.ts'

function resolvedNamedImport(
	source: string,
	modulePath: string,
	exportName: string,
) {
	const match = source.match(
		new RegExp(
			`import\\s*\\{[^}]*\\b${exportName}\\b[^}]*\\}\\s*from\\s*"([^"]+)"`,
		),
	)
	if (!match?.[1]) return null
	return path.posix.normalize(
		path.posix.join(path.posix.dirname(modulePath), match[1]),
	)
}

test('rewriteLocalExecuteSecretPlaceholderLiterals removes resolvable template literals', async () => {
	const source = `const token = '{{secret:demoToken|scope=user}}'
export async function request() {
  return fetch('https://api.example.com/v1', {
    headers: { authorization: 'Bearer ' + token },
  })
}`
	const rewritten = await rewriteLocalExecuteSecretPlaceholderLiterals(source)
	expect(rewritten.rewritten).toBe(true)
	expect(rewritten.source).not.toContain('{{secret:demoToken|scope=user}}')
	expect(rewritten.source).toMatch(
		/__kodySecretRef\(\s*"demoToken"\s*,\s*"user"\s*\)/,
	)
	expect(rewritten.source).toContain("fetch('https://api.example.com/v1'")
})

test('rewriteLocalExecuteSecretPlaceholderLiterals leaves non-computed object keys alone', async () => {
	const source = `const map = { '{{secret:demoToken|scope=user}}': true }
const value = '{{secret:demoToken|scope=user}}'
`
	const rewritten = await rewriteLocalExecuteSecretPlaceholderLiterals(source)
	expect(rewritten.rewritten).toBe(true)
	expect(rewritten.source).toContain(
		"{ '{{secret:demoToken|scope=user}}': true }",
	)
	expect(rewritten.source).toContain('__kodySecretRef("demoToken", "user")')
})

test('rewriteLocalExecuteModuleForSecretAwareFetch binds gateway fetch and strips templates', async () => {
	const source = `const SECRET = '{{secret:demoToken|scope=user}}'
export async function listSites() {
  return fetch('https://api.usefathom.com/v1/sites', {
    headers: { authorization: 'Bearer ' + SECRET },
  })
}`
	const modulePath =
		'.__kody_packages__/demo/.__published_bundle__/artifact/dist/index.js'
	const primaryRuntimePath = '.__kody_virtual__/runtime.js'
	const rewritten = await rewriteLocalExecuteModuleForSecretAwareFetch({
		modulePath,
		source,
		primaryRuntimePath,
		packageId: 'pkg-demo',
	})
	expect(rewritten.rewritten).toBe(true)
	expect(rewritten.source).not.toContain('{{secret:demoToken|scope=user}}')
	expect(rewritten.source).toContain('__kodySecretRef("demoToken", "user")')
	expect(rewritten.source).toContain(
		'const fetch = __kodyCreatePackageBoundGatewayFetch("pkg-demo");',
	)
	expect(
		resolvedNamedImport(
			rewritten.source,
			modulePath,
			'__kodyCreatePackageBoundGatewayFetch',
		),
	).toBe(primaryRuntimePath)
	expect(rewritten.source).toContain(
		"fetch('https://api.usefathom.com/v1/sites'",
	)
})

test('injectLocalExecuteGatewayFetchBinding skips when fetch is already bound', async () => {
	const source = `const fetch = globalThis.fetch;
const SECRET = '{{secret:demoToken|scope=user}}';
`
	const modulePath =
		'.__kody_packages__/demo/.__published_bundle__/artifact/dist/index.js'
	const primaryRuntimePath = '.__kody_virtual__/runtime.js'
	const placeholders =
		await rewriteLocalExecuteSecretPlaceholderLiterals(source)
	const injected = await injectLocalExecuteGatewayFetchBinding({
		modulePath,
		source: placeholders.source,
		primaryRuntimePath,
		packageId: 'pkg-demo',
	})
	expect(injected.source).toContain('__kodySecretRef("demoToken", "user")')
	expect(
		resolvedNamedImport(injected.source, modulePath, '__kodySecretRef'),
	).toBe(primaryRuntimePath)
	expect(injected.source).not.toContain('__kodyCreatePackageBoundGatewayFetch')
	expect(injected.source).toMatch(/const fetch = globalThis\.fetch/)
})

test('ensureLocalExecuteMeterStaticPackageExportImport binds free meter calls', async () => {
	const mergeSource = `import {
	__kodySecretRef,
	__kodyCreatePackageBoundGatewayFetch,
} from "../../../../../.__kody_virtual__/runtime.js";
var fetch = __kodyCreatePackageBoundGatewayFetch("280d0259-20e7-4fbb-9e22-5a50728bcf65");
var editMessage = __kodyMeterStaticPackageExport("41095c29-4539-4f2f-a6fb-646348602c18", rawEdit);
export default async function advance() { return editMessage }
`
	const modulePath =
		'.__kody_packages__/demo/.__published_bundle__/artifact/dist/index.js'
	const primaryRuntimePath = '.__kody_virtual__/runtime.js'
	const merged = await ensureLocalExecuteMeterStaticPackageExportImport({
		modulePath,
		source: mergeSource,
		primaryRuntimePath,
	})
	expect(merged.rewritten).toBe(true)
	expect(
		resolvedNamedImport(
			merged.source,
			modulePath,
			'__kodyMeterStaticPackageExport',
		),
	).toBe(primaryRuntimePath)
	expect(merged.source.match(/__kodyMeterStaticPackageExport/g)?.length).toBe(2)
	expect(merged.source).toContain(
		'var editMessage = __kodyMeterStaticPackageExport("41095c29-4539-4f2f-a6fb-646348602c18", rawEdit)',
	)

	const noMeter = `export default async function main() { return 1 }`
	expect(
		await ensureLocalExecuteMeterStaticPackageExportImport({
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
	const besideAlias = await ensureLocalExecuteMeterStaticPackageExportImport({
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
		await ensureLocalExecuteMeterStaticPackageExportImport({
			modulePath:
				'.__kody_packages__/demo/.__published_bundle__/artifact/dist/index.js',
			source: alreadyBound,
			primaryRuntimePath: '.__kody_virtual__/runtime.js',
		}),
	).toEqual({ source: alreadyBound, rewritten: false })
})
