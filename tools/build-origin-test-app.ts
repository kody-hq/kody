import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveLocalBinary } from './node-runtime.ts'

/** Compile the real origin, including Start's generated server entries. */
export async function buildOriginTestApp() {
	const directory = await mkdtemp(path.join(tmpdir(), 'kody-origin-test-'))
	try {
		await promisify(execFile)(resolveLocalBinary('vite'), ['build'], {
			cwd: process.cwd(),
			env: {
				...process.env,
				CLOUDFLARE_ENV: 'test',
				KODY_WRANGLER_CONFIG: path.resolve('packages/worker/wrangler.jsonc'),
				KODY_VITE_OUTDIR: directory,
			},
			maxBuffer: 20 * 1024 * 1024,
		})
		// The generated deployment redirect is not used by local harness workers.
		await rm(path.resolve('.wrangler/deploy/config.json'), { force: true })
		return {
			configPath: path.join(directory, 'server/wrangler.json'),
			close: () => rm(directory, { recursive: true, force: true }),
		}
	} catch (error) {
		await rm(directory, { recursive: true, force: true })
		throw error
	}
}
