import { writeFile } from 'node:fs/promises'
import { experimental_generateTypes } from 'wrangler'
import { isExecutedDirectly } from './node-runtime.ts'
import { stripWorkerProcessEnvTypes } from './strip-worker-process-env-types.ts'
import { widenSentryEnvironmentType } from './widen-sentry-environment-type.ts'

export const workerConfigurationTypesPath =
	'packages/worker/worker-configuration.d.ts'
export const workerConfigurationTypesCheckPath =
	'packages/worker/worker-configuration.check.d.ts'

const workerConfigPath = 'packages/worker/wrangler.jsonc'
const workerTypeSecretsEnvFile = 'worker-type-secrets.env'

export async function generateWorkerConfigurationTypes(outputPath: string) {
	// Node's CLI eats `--env-file` before Wrangler sees it, and a machine-local
	// `.env` would otherwise change the generated secret bindings. Pass the
	// committed secret-name file through Wrangler's API, and do not let
	// `process.env` add more keys.
	process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false'
	const generated = await experimental_generateTypes({
		config: [
			workerConfigPath,
			'packages/platform-worker/wrangler.jsonc',
			'packages/runtime-worker/wrangler.jsonc',
		],
		env: 'production',
		envFile: [workerTypeSecretsEnvFile],
		path: outputPath,
		includeRuntime: true,
		includeEnv: true,
	})
	const stripped = ensureTrailingNewline(
		widenSentryEnvironmentType(stripWorkerProcessEnvTypes(generated.content)),
	)
	await writeFile(outputPath, stripped)
	return stripped
}

export function normalizeWorkerConfigurationTypes(
	source: string,
	fromPath: string,
	toPath: string,
) {
	return source.replaceAll(fromPath, toPath)
}

function ensureTrailingNewline(source: string) {
	return source.endsWith('\n') ? source : `${source}\n`
}

if (isExecutedDirectly(import.meta.url)) {
	await generateWorkerConfigurationTypes(workerConfigurationTypesPath)
}
