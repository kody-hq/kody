import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { envWithNodeHeapFloor, isExecutedDirectly } from './node-runtime.ts'

export type TscRunResult = {
	status: number
	env: NodeJS.ProcessEnv
}

// Running tsc's JS entry with node avoids the Windows `tsc.cmd` shim, which
// needs a shell (same reason `tools/run-nx.ts` uses `process.execPath`).
function resolveTscEntry() {
	const require = createRequire(import.meta.url)
	const packageJsonPath = require.resolve('typescript/package.json')
	const { bin } = require(packageJsonPath) as { bin: { tsc: string } }
	return join(dirname(packageJsonPath), bin.tsc)
}

/**
 * Spawn `tsc` with the same heap floor as `tools/run-nx.ts` and git hooks.
 * `npm run typecheck:start` used to inherit Node's ~2GB default and OOM
 * during parallel `validate` on 16GB Cloud Agent VMs.
 */
export function spawnTsc(
	args: ReadonlyArray<string>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<TscRunResult> {
	const childEnv = envWithNodeHeapFloor(env)
	const inherit = isExecutedDirectly(import.meta.url)
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [resolveTscEntry(), ...args], {
			env: childEnv,
			stdio: inherit ? 'inherit' : 'ignore',
		})
		child.once('error', () => {
			resolve({ status: 1, env: childEnv })
		})
		child.once('exit', (code) => {
			resolve({ status: code ?? 1, env: childEnv })
		})
	})
}

if (isExecutedDirectly(import.meta.url)) {
	const result = await spawnTsc(process.argv.slice(2))
	process.exit(result.status)
}
