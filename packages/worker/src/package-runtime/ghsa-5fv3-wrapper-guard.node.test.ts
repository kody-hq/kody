/**
 * Guard for GHSA-5fv3-qv7j-rqf5: the static-import metering wrapper routes
 * metering only. If it (or a pass-through it calls) ever opens package
 * identity around importer-reachable code again, these fail.
 */
import { expect, test } from 'vitest'
import { createLocalExecuteRuntimeShimSource } from './local-execute-runtime-support.ts'
import { runtimeModulePath } from './module-graph-paths.ts'
import { createRuntimeModuleSource } from './runtime-source-modules.ts'

/**
 * Names that enter, read, or switch package identity in the hosted runtime
 * or the local shim. None belongs inside the metering wrapper.
 */
const identityGrantingNames = [
	'SecretAuthority',
	'secretAuthority',
	'__kodyPackageBindingStorage',
	'__kodyRunWithPackageBindings',
	'__kodyPackageBindingFor',
	'__kodyPackageBindings',
	'__kodyPackageBinding(',
	'__kodyAlsRun',
	'__kodyRuntimeStorage',
	'__kodyRunInRuntime',
	'__kodyCreatePackageBound',
	'kody.getSecretAuthority',
]

function functionSource(source: string, name: string) {
	const start = source.indexOf(`export function ${name}(`)
	expect(start, `${name} is defined`).toBeGreaterThan(-1)
	// The wrapper is followed by another top-level declaration; take
	// everything up to the next one.
	const rest = source.slice(start + 1)
	const next = rest.search(/\n(?:export )?(?:async )?(?:function|const|let) /)
	return next === -1 ? rest : rest.slice(0, next)
}

const sources = {
	hosted: createRuntimeModuleSource(),
	local: createLocalExecuteRuntimeShimSource(runtimeModulePath, {
		packageBindings: { 'pkg-a': 'kpb1.a.sig' },
	}),
}

for (const [label, source] of Object.entries(sources)) {
	test(`${label} metering wrapper never touches package identity`, () => {
		const wrapper = functionSource(source, '__kodyMeterStaticPackageExport')
		expect(wrapper).toContain('__kodyMeterStaticPackageExport')
		for (const name of identityGrantingNames) {
			expect(wrapper, `${label} wrapper references ${name}`).not.toContain(name)
		}
	})
}
