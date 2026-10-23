import { expect, test } from 'vitest'
import {
	repairInlinedFacadeBindings,
	repairInlinedFacadeBindingsInArtifact,
} from './inlined-facade-binding-repair.ts'

/** A facade head and body as the pre-fix builder emitted them. */
function legacyFacade(packageId: string, suffix = '', runtime = '.') {
	const id = JSON.stringify(packageId)
	const n = suffix
	const spec = JSON.stringify(`${runtime}/.__kody_virtual__/runtime.js`)
	const renamed = (name: string) => (n ? `${name} as ${name}${n}` : name)
	return [
		`import { ${['createAuthenticatedFetch', 'secretHeaders', 'oauthClientCredentials', 'packageContext'].map(renamed).join(', ')} } from ${spec};`,
		`import __kodyBaseRuntimeDefault${n}, { ${['__kodyCreatePackageBoundCredentialRuntime', '__kodyCreatePackageBoundFetch', '__kodyCreatePackageBoundKody'].map(renamed).join(', ')} } from ${spec};`,
		`var __kodyBoundFetch${n} = __kodyCreatePackageBoundFetch${n}(${id});`,
		`var kody${n} = __kodyCreatePackageBoundKody${n}(${id});`,
		`var __kodyPackageCredentialRuntime${n} = __kodyCreatePackageBoundCredentialRuntime${n}(${id});`,
		`var credential${n} = __kodyPackageCredentialRuntime${n}.credential;`,
		`var __kodyPackageBound${n} = Object.fromEntries(`,
		`  Object.entries({ credential: credential${n} }).filter(([, value]) => value !== void 0)`,
		`);`,
		`var KodyRuntime${n} = Object.freeze({ defaultValue: __kodyPackageBound${n} });`,
	].join('\n')
}

const outerCode = `async function call() {
  return await createAuthenticatedFetch("svc");
}`
const innerCode = `async function innerCall() {
  return await createAuthenticatedFetch2("svc");
}`

test('binds the integration helpers of an inlined facade to its package', () => {
	const source = `// virtual:.__kody_virtual__/package-runtime/00.js\n${legacyFacade('pkg-outer')}\n${outerCode}\n`
	const repaired = repairInlinedFacadeBindings({
		source,
		allowedPackageIds: new Set(['pkg-outer']),
	})!
	expect(repaired).toContain(
		'import { secretHeaders, packageContext } from "./.__kody_virtual__/runtime.js";',
	)
	expect(repaired).toContain(
		'import { __kodyCreatePackageBoundAuthenticatedFetch, __kodyCreatePackageBoundOauthClientCredentials } from "./.__kody_virtual__/runtime.js";',
	)
	expect(repaired).toContain(
		'var createAuthenticatedFetch = __kodyCreatePackageBoundAuthenticatedFetch("pkg-outer");',
	)
	expect(repaired).toContain(
		'var oauthClientCredentials = __kodyCreatePackageBoundOauthClientCredentials("pkg-outer");',
	)
	expect(repaired).toContain(
		'Object.entries({ credential: credential, createAuthenticatedFetch: createAuthenticatedFetch, oauthClientCredentials: oauthClientCredentials })',
	)
	// The package code is untouched.
	expect(repaired).toContain(outerCode)
	// Running it again finds nothing left to bind.
	expect(
		repairInlinedFacadeBindings({
			source: repaired,
			allowedPackageIds: new Set(['pkg-outer']),
		}),
	).toBeNull()
})

test("binds each inlined package's renamed helper to that package", () => {
	const source = [
		legacyFacade('pkg-outer'),
		'// virtual:.__kody_packages__/@a/inner/.__published_bundle__/00/bundle.js',
		legacyFacade(
			'pkg-inner',
			'2',
			'./.__kody_packages__/@a/inner/.__published_bundle__/00',
		),
		innerCode,
		outerCode,
	].join('\n')
	const repaired = repairInlinedFacadeBindings({
		source,
		allowedPackageIds: new Set(['pkg-outer', 'pkg-inner']),
	})!
	expect(repaired).toContain(
		'var createAuthenticatedFetch = __kodyCreatePackageBoundAuthenticatedFetch("pkg-outer");',
	)
	expect(repaired).toContain(
		'var createAuthenticatedFetch2 = __kodyCreatePackageBoundAuthenticatedFetch1("pkg-inner");',
	)
	expect(repaired).toContain(
		'import { __kodyCreatePackageBoundAuthenticatedFetch as __kodyCreatePackageBoundAuthenticatedFetch1, __kodyCreatePackageBoundOauthClientCredentials as __kodyCreatePackageBoundOauthClientCredentials1 } from "./.__kody_packages__/@a/inner/.__published_bundle__/00/.__kody_virtual__/runtime.js";',
	)
})

test('leaves facades outside bundler provenance and current bundles alone', () => {
	const legacy = `${legacyFacade('pkg-elsewhere')}\n${outerCode}\n`
	expect(
		repairInlinedFacadeBindings({
			source: legacy,
			allowedPackageIds: new Set(['pkg-outer']),
		}),
	).toBeNull()
	const current = `import { secretHeaders } from "./.__kody_virtual__/runtime.js";
import __kodyBaseRuntimeDefault, { __kodyCreatePackageBoundFetch, __kodyCreatePackageBoundKody, __kodyCreatePackageBoundAuthenticatedFetch } from "./.__kody_virtual__/runtime.js";
var __kodyBoundFetch = __kodyCreatePackageBoundFetch("pkg-outer");
var kody = __kodyCreatePackageBoundKody("pkg-outer");
var createAuthenticatedFetch = __kodyCreatePackageBoundAuthenticatedFetch("pkg-outer");
${outerCode}`
	expect(
		repairInlinedFacadeBindings({
			source: current,
			allowedPackageIds: new Set(['pkg-outer']),
		}),
	).toBeNull()
})

test('repairs artifact modules using the artifact provenance only', () => {
	const artifact = {
		modules: {
			'bundle.js': `${legacyFacade('pkg-outer')}\n${outerCode}\n`,
			'other.js': { js: `${legacyFacade('pkg-dep')}\n${outerCode}\n` },
			'plain.js': 'export default 1',
		},
		dependencies: [{ packageId: 'pkg-dep' }],
		packageContext: { packageId: 'pkg-outer' },
	}
	const repaired = repairInlinedFacadeBindingsInArtifact(artifact)
	expect(repaired.modules['bundle.js']).toContain(
		'__kodyCreatePackageBoundAuthenticatedFetch("pkg-outer")',
	)
	expect((repaired.modules['other.js'] as { js: string }).js).toContain(
		'__kodyCreatePackageBoundAuthenticatedFetch("pkg-dep")',
	)
	expect(repaired.modules['plain.js']).toBe('export default 1')
	expect(artifact.modules['bundle.js']).not.toContain(
		'__kodyCreatePackageBoundAuthenticatedFetch',
	)
	const unrelated = { ...artifact, packageContext: null, dependencies: [] }
	expect(repairInlinedFacadeBindingsInArtifact(unrelated)).toBe(unrelated)
})

test('a facade without its end marker does not swallow the next facade', () => {
	const truncated = legacyFacade('pkg-outer')
		.split('\n')
		.filter((line) => !line.startsWith('var KodyRuntime'))
		.join('\n')
	const innerHead = legacyFacade(
		'pkg-inner',
		'2',
		'./.__kody_packages__/@a/inner/.__published_bundle__/00',
	)
	const source = [truncated, innerHead, innerCode, outerCode].join('\n')
	const repaired = repairInlinedFacadeBindings({
		source,
		allowedPackageIds: new Set(['pkg-outer', 'pkg-inner']),
	})!
	const count = (needle: string) => repaired.split(needle).length - 1
	expect(count('var kody2 = __kodyCreatePackageBoundKody2("pkg-inner");')).toBe(
		1,
	)
	expect(count('var kody = __kodyCreatePackageBoundKody("pkg-outer");')).toBe(1)
	expect(count('var KodyRuntime2 = ')).toBe(1)
	expect(repaired).toContain(
		'var createAuthenticatedFetch2 = __kodyCreatePackageBoundAuthenticatedFetch1("pkg-inner");',
	)
	expect(repaired).toContain(
		'Object.entries({ credential: credential2, createAuthenticatedFetch: createAuthenticatedFetch2, oauthClientCredentials: oauthClientCredentials2 })',
	)
	expect(repaired).toContain(innerCode)
	expect(repaired).toContain(outerCode)
})

/**
 * A facade as builders before GHSA-5fv3 (fe2aca6a9) emitted it and esbuild
 * inlined it: storage, secrets, and credentials are bound, with no lexical
 * `fetch` or `kody`.
 */
function preFixFacade(packageId: string, n = '') {
	const id = JSON.stringify(packageId)
	const renamed = (name: string) => (n ? `${name} as ${name}${n}` : name)
	const spec = '"./.__kody_virtual__/runtime.js"'
	return [
		`import { ${['kody', 'createAuthenticatedFetch', 'secretHeaders', 'oauthClientCredentials', 'packageContext'].map(renamed).join(', ')} } from ${spec};`,
		`import __kodyBaseRuntimeDefault${n}, { ${['__kodyCreatePackageBoundStorage', '__kodyCreatePackageBoundSecrets', '__kodyCreatePackageBoundCredentialRuntime'].map(renamed).join(', ')} } from ${spec};`,
		`var packageStorage${n} = __kodyCreatePackageBoundStorage${n}(${id});`,
		`var packageSecrets${n} = __kodyCreatePackageBoundSecrets${n}(${id});`,
		`var __kodyPackageCredentialRuntime${n} = __kodyCreatePackageBoundCredentialRuntime${n}(${id});`,
		`var credential${n} = __kodyPackageCredentialRuntime${n}.credential;`,
		`var credentials${n} = __kodyPackageCredentialRuntime${n}.credentials;`,
		`var __kodyPackageBound${n} = Object.fromEntries(`,
		`  Object.entries({ packageStorage${n ? `: packageStorage${n}` : ''}, credential${n ? `: credential${n}` : ''} }).filter(([, value]) => value !== void 0)`,
		`);`,
		`var KodyRuntime${n} = Object.freeze({ defaultValue: __kodyPackageBound${n} });`,
	].join('\n')
}

test('binds a pre-fix facade that has no lexical fetch or kody', () => {
	const source = [
		preFixFacade('pkg-outer'),
		preFixFacade('pkg-inner', '2'),
		innerCode,
		outerCode,
	].join('\n')
	expect(source).not.toContain('__kodyCreatePackageBoundKody')
	const repaired = repairInlinedFacadeBindings({
		source,
		allowedPackageIds: new Set(['pkg-outer', 'pkg-inner']),
	})!
	expect(repaired).toContain(
		'import { kody, secretHeaders, packageContext } from "./.__kody_virtual__/runtime.js";\nimport { __kodyCreatePackageBoundAuthenticatedFetch, __kodyCreatePackageBoundOauthClientCredentials } from "./.__kody_virtual__/runtime.js";',
	)
	expect(repaired).toContain(
		'var packageStorage = __kodyCreatePackageBoundStorage("pkg-outer");\nvar createAuthenticatedFetch = __kodyCreatePackageBoundAuthenticatedFetch("pkg-outer");\nvar oauthClientCredentials = __kodyCreatePackageBoundOauthClientCredentials("pkg-outer");',
	)
	expect(repaired).toContain(
		'var createAuthenticatedFetch2 = __kodyCreatePackageBoundAuthenticatedFetch1("pkg-inner");',
	)
	expect(repaired).toContain(
		'Object.entries({ packageStorage, credential, createAuthenticatedFetch: createAuthenticatedFetch, oauthClientCredentials: oauthClientCredentials })',
	)
	expect(repaired).toContain(innerCode)
	expect(repaired).toContain(outerCode)
	expect(
		repairInlinedFacadeBindings({
			source: repaired,
			allowedPackageIds: new Set(['pkg-outer', 'pkg-inner']),
		}),
	).toBeNull()
})

test('binds a pre-fix facade after the single-package repair rebinds kody', () => {
	// repairPreBindingPublishedArtifact runs first on single-package bundles:
	// it drops `kody` from the shared import and prepends bound fetch/kody.
	const source = [
		'import { __kodyCreatePackageBoundFetch as __kodyPreBindingBoundFetch, __kodyCreatePackageBoundKody as __kodyPreBindingBoundKody } from "./.__kody_virtual__/runtime.js";',
		'const fetch = __kodyPreBindingBoundFetch("pkg-outer");',
		'const kody = __kodyPreBindingBoundKody("pkg-outer");',
		preFixFacade('pkg-outer').replace('import { kody, ', 'import { '),
		outerCode,
	].join('\n')
	const repaired = repairInlinedFacadeBindings({
		source,
		allowedPackageIds: new Set(['pkg-outer']),
	})!
	expect(repaired).toContain(
		'var createAuthenticatedFetch = __kodyCreatePackageBoundAuthenticatedFetch("pkg-outer");',
	)
	expect(repaired).toContain(
		'const kody = __kodyPreBindingBoundKody("pkg-outer");',
	)
})

/** A facade from the `export *` era as esbuild inlined it. */
function starFacade(packageId: string, n = '') {
	const id = JSON.stringify(packageId)
	const short = n ? `${n}` : ''
	return [
		`var f${short}_exports = {};`,
		`__export(f${short}_exports, {`,
		`  KodyRuntime: () => KodyRuntime${n},`,
		`  default: () => f${short}_default,`,
		`  packageStorage: () => packageStorage${n}`,
		`});`,
		`__reExport(f${short}_exports, runtime_star${n});`,
		`import * as runtime_star${n} from "./.__kody_virtual__/runtime.js";`,
		`import __kodyBaseRuntimeDefault${n}, { __kodyCreatePackageBoundStorage${n ? ` as __kodyCreatePackageBoundStorage${n}` : ''} } from "./.__kody_virtual__/runtime.js";`,
		`var packageStorage${n} = __kodyCreatePackageBoundStorage${n}(${id});`,
		`var __kodyPackageRuntimeDefault${n} = new Proxy(__kodyBaseRuntimeDefault${n}, {`,
		`  get(target, property, receiver) {`,
		`    if (property === "packageStorage") return packageStorage${n};`,
		`    return Reflect.get(target, property, receiver);`,
		`  }`,
		`});`,
		`var f${short}_default = __kodyPackageRuntimeDefault${n};`,
		`var KodyRuntime${n} = Object.freeze({ defaultValue: __kodyPackageRuntimeDefault${n} });`,
	].join('\n')
}

test('binds an `export *` era facade on its namespace and default export', () => {
	const code =
		'async function call() {\n  return await (0, f_exports.createAuthenticatedFetch)("svc");\n}'
	const source = [
		starFacade('pkg-outer'),
		starFacade('pkg-inner', '2'),
		code,
	].join('\n')
	const repaired = repairInlinedFacadeBindings({
		source,
		allowedPackageIds: new Set(['pkg-outer', 'pkg-inner']),
	})!
	expect(repaired).toContain(
		'  packageStorage: () => packageStorage,\n  createAuthenticatedFetch: () => createAuthenticatedFetch1,\n  oauthClientCredentials: () => oauthClientCredentials\n});\n__reExport(f_exports, runtime_star);',
	)
	expect(repaired).toContain(
		'var packageStorage = __kodyCreatePackageBoundStorage("pkg-outer");\nimport { __kodyCreatePackageBoundAuthenticatedFetch, __kodyCreatePackageBoundOauthClientCredentials } from "./.__kody_virtual__/runtime.js";\nvar createAuthenticatedFetch1 = __kodyCreatePackageBoundAuthenticatedFetch("pkg-outer");',
	)
	expect(repaired).toContain(
		'  get(target, property, receiver) {\n    if (property === "createAuthenticatedFetch" && createAuthenticatedFetch1 !== void 0) return createAuthenticatedFetch1;\n',
	)
	expect(repaired).toContain(
		'var createAuthenticatedFetch2 = __kodyCreatePackageBoundAuthenticatedFetch1("pkg-inner");',
	)
	expect(repaired).toContain(code)
	expect(
		repairInlinedFacadeBindings({
			source: repaired,
			allowedPackageIds: new Set(['pkg-outer', 'pkg-inner']),
		}),
	).toBeNull()
})

test('skips a facade that binds more than one package or imports non-creators', () => {
	const mixedIds = preFixFacade('pkg-outer').replace(
		'__kodyCreatePackageBoundSecrets("pkg-outer")',
		'__kodyCreatePackageBoundSecrets("pkg-other")',
	)
	expect(
		repairInlinedFacadeBindings({
			source: `${mixedIds}\n${outerCode}`,
			allowedPackageIds: new Set(['pkg-outer', 'pkg-other']),
		}),
	).toBeNull()
	const notAFacade = preFixFacade('pkg-outer').replace(
		'__kodyCreatePackageBoundSecrets, ',
		'__kodyCreatePackageBoundSecrets, somethingElse, ',
	)
	expect(
		repairInlinedFacadeBindings({
			source: `${notAFacade}\n${outerCode}`,
			allowedPackageIds: new Set(['pkg-outer']),
		}),
	).toBeNull()
})
