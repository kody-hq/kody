import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseCiShard } from './ci-shard.ts'
import { isExecutedDirectly } from './node-runtime.ts'

export function workersUnitTestArgs(shardValue: string | undefined) {
	const shard = parseCiShard(shardValue)
	return [
		'run',
		'--project',
		'workers-unit',
		...(shard ? ['--shard', `${shard.current}/${shard.total}`] : []),
	]
}

if (isExecutedDirectly(import.meta.url)) {
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(
				new URL('../node_modules/vitest/vitest.mjs', import.meta.url),
			),
			...workersUnitTestArgs(process.env.WORKERS_TEST_SHARD),
			...process.argv.slice(2),
		],
		{ stdio: 'inherit' },
	)
	if (result.error) throw result.error
	process.exitCode = result.status ?? 1
}
