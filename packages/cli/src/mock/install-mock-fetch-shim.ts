/**
 * When `.kody/mocks.ts` is active under `--target mock`, embed the CLI-owned
 * gateway-fetch shim and ensure the workerd entry side-effect imports it.
 *
 * Keep the origin `.__kody_virtual__/runtime.js` module (CAF / packageStorage
 * re-exports). Register the mock wrap under a *flat* module name so bare
 * `kody:runtime` does not path-join under `.__kody_virtual__/` (same workerd
 * rule as kody-hq/kody local-execute-package-graph).
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { localExecuteGatewayFetchShimModuleName } from '../local-package-graph.js'
import type { WorkerdPackageModuleFile } from '../local-runtime-source.js'
import { createMockGatewayFetchShimSource } from './mock-gateway-fetch-shim.js'

const mockShimFileName = 'mock-gateway-fetch-shim.js'

/** Flat workerd module name — must not contain `/` (path-join hazard). */
export const mockGatewayFetchShimModuleName = '.__kody_mock_gateway_fetch__.js'

export async function installMockFetchShimModules(input: {
	workDir: string
	packageModules: Array<WorkerdPackageModuleFile>
}): Promise<{
	packageModules: Array<WorkerdPackageModuleFile>
	sideEffectModules: Array<string>
}> {
	const withoutDup = input.packageModules.filter(
		(module) => module.name !== mockGatewayFetchShimModuleName,
	)
	await writeFile(
		join(input.workDir, mockShimFileName),
		createMockGatewayFetchShimSource(),
	)
	const originShimNames = withoutDup
		.map((module) => module.name)
		.filter((name) => name === localExecuteGatewayFetchShimModuleName)
	return {
		packageModules: [
			...withoutDup,
			{
				name: mockGatewayFetchShimModuleName,
				file: mockShimFileName,
			},
		],
		// Origin first (runtime re-exports + secret wrap), mock last so ambient
		// fetch is fail-closed through the Node MSW gateway.
		sideEffectModules: [...originShimNames, mockGatewayFetchShimModuleName],
	}
}
