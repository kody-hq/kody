import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type MiniflareOptions } from 'miniflare'

export async function spikeRuntimeOptions(
	persistence?: string,
	s3Configuration?: string,
): Promise<MiniflareOptions> {
	return {
		host: '127.0.0.1',
		port: 0,
		resourcePersistencePath: persistence,
		workers: [
			{
				config: {
					name: 'files-spike',
					compatibilityDate: '2026-10-01',
					compatibilityFlags: ['nodejs_compat'],
					manifest: {
						mainModule: 'worker.mjs',
						modulesRoot: resolve('.tmp'),
						modules: {
							'worker.mjs': {
								type: 'esm',
								contents: await readFile('.tmp/files-spike-worker.mjs', 'utf8'),
							},
						},
					},
					exports: {
						SpikeDocument: { type: 'durable-object', storage: 'sqlite' },
						SpikeDirectory: { type: 'durable-object', storage: 'sqlite' },
					},
					env: {
						DOCUMENTS: {
							type: 'durable-object',
							worker: 'files-spike',
							exportName: 'SpikeDocument',
						},
						DIRECTORY: {
							type: 'durable-object',
							worker: 'files-spike',
							exportName: 'SpikeDirectory',
						},
						INCLUDED_FILES: { type: 'r2', name: 'files-spike-included' },
						EXTERNAL_FILES: { type: 'r2', name: 'files-spike-external' },
						ASSETS: { type: 'assets' },
						...(s3Configuration
							? {
									S3_CONFIGURATION: {
										type: 'text' as const,
										value: s3Configuration,
									},
								}
							: {}),
					},
					assets: {
						directory: resolve('.tmp/files-spike'),
						hasUserWorker: true,
						runWorkerFirst: true,
					},
				},
			},
		],
	}
}
