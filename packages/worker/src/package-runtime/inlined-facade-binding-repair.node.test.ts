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
