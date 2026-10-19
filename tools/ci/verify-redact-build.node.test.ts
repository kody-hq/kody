import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true })
})
function build(clientSources: string[], serverSources: string[] = []) {
	const root = mkdtempSync(join(tmpdir(), 'kody-build-boundary-'))
	directories.push(root)
	for (const [environment, sources] of [
		['client', clientSources],
		['server', serverSources],
	] as const) {
		mkdirSync(join(root, environment))
		writeFileSync(
			join(root, environment, 'bundle.js.map'),
			JSON.stringify({
				sources: ['../../node_modules/@tanstack/redact/index.ts', ...sources],
			}),
		)
	}
	return () =>
		execFileSync(
			process.execPath,
			[resolve('tools/ci/verify-redact-build.mjs'), root],
			{ stdio: 'pipe' },
		)
}
test('build verification rejects server-only OAuth and rasterization sources in client bundles', () => {
	for (const source of [
		'../../node_modules/@resvg/resvg-wasm/index.js',
		'../../packages/worker/start/server/package-app-oauth-protocol.ts',
		'../../packages/worker/src/app/package-app-oauth-authorize.ts',
	]) {
		expect(build([source])).toThrow(
			'server-only OAuth or image rasterization modules',
		)
		expect(build([], [source])).not.toThrow()
	}
})
