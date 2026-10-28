import { spawnSync } from 'node:child_process'
import { resolveNpmCommand } from './node-runtime.ts'

// `CI=1 npm run ...` breaks under cmd.exe, npm's default script shell on Windows.
for (const script of ['test:node', 'test:workers']) {
	const result = spawnSync(resolveNpmCommand(), ['run', script], {
		stdio: 'inherit',
		env: { ...process.env, CI: '1' },
		// Node refuses to spawn `npm.cmd` without a shell on Windows.
		shell: process.platform === 'win32',
	})
	if (result.error) throw result.error
	if (result.status !== 0) {
		process.exitCode = result.status ?? 1
		break
	}
}
