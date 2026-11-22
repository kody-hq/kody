import { readFile, writeFile } from 'node:fs/promises'
import { isExecutedDirectly } from '../node-runtime.ts'
import { fail, parseJsonc } from './resource-utils.ts'

/**
 * Generate the preview Wrangler config for the `api.kody.codes` edge worker
 * (`packages/api-worker`). Previews deploy it as `<app-worker>-api` on
 * workers.dev, bound to the per-preview app worker's `KodyApi` entrypoint
 * and its repo session blobs bucket (package check upload staging).
 * Production deploys the committed config unchanged.
 */

const defaultBaseConfigPath = 'packages/api-worker/wrangler.jsonc'

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown, label: string): JsonRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} is not an object.`)
	}
	return value as JsonRecord
}

export function buildPreviewApiWorkerConfig(
	baseConfig: JsonRecord,
	input: {
		workerName: string
		appWorkerName: string
		repoSessionBlobsBucketName: string
	},
): JsonRecord {
	const config = structuredClone(baseConfig)
	const envs = asRecord(config.env, 'api worker config "env"')
	const preview = asRecord(envs.preview, 'api worker config "env.preview"')
	const services = preview.services
	if (!Array.isArray(services)) {
		throw new Error('api worker config "env.preview.services" is missing.')
	}
	const binding = services
		.map((entry, index) => asRecord(entry, `env.preview.services[${index}]`))
		.find((entry) => entry.binding === 'KODY_API')
	if (!binding) {
		throw new Error('api worker config has no env.preview KODY_API binding.')
	}
	binding.service = input.appWorkerName
	const buckets = preview.r2_buckets
	if (!Array.isArray(buckets)) {
		throw new Error('api worker config "env.preview.r2_buckets" is missing.')
	}
	const bucket = buckets
		.map((entry, index) => asRecord(entry, `env.preview.r2_buckets[${index}]`))
		.find((entry) => entry.binding === 'REPO_SESSION_BLOBS')
	if (!bucket) {
		throw new Error(
			'api worker config has no env.preview REPO_SESSION_BLOBS binding.',
		)
	}
	bucket.bucket_name = input.repoSessionBlobsBucketName
	config.name = input.workerName
	config.env = { preview }
	return config
}

function readFlag(argv: Array<string>, name: string) {
	const index = argv.indexOf(name)
	const value = index === -1 ? undefined : argv[index + 1]
	if (!value || value.startsWith('--')) fail(`Missing required flag: ${name}`)
	return value
}

export async function main(argv = process.argv.slice(2)) {
	const workerName = readFlag(argv, '--worker-name')
	const appWorkerName = readFlag(argv, '--app-worker-name')
	const repoSessionBlobsBucketName = readFlag(
		argv,
		'--repo-session-blobs-bucket',
	)
	const outConfigPath = readFlag(argv, '--out-config')
	const baseConfig = parseJsonc<JsonRecord>(
		await readFile(defaultBaseConfigPath, 'utf8'),
	)
	const config = buildPreviewApiWorkerConfig(baseConfig, {
		workerName,
		appWorkerName,
		repoSessionBlobsBucketName,
	})
	await writeFile(outConfigPath, `${JSON.stringify(config, null, '\t')}\n`)
	console.log(`api_wrangler_config=${outConfigPath}`)
	console.log(`api_worker_name=${workerName}`)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
