import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseJsonc } from './ci/resource-utils.ts'
import { localizeMigrations } from './local-dev-migrations.ts'

type JsonRecord = Record<string, unknown>

function requireRuntimeEnv(
	config: JsonRecord,
	runtimeConfigPath: string,
	envName: string,
) {
	const envs = config.env
	if (!envs || typeof envs !== 'object') {
		throw new Error(`${runtimeConfigPath} is missing "env".`)
	}
	const runtimeEnv = (envs as JsonRecord)[envName]
	if (!runtimeEnv || typeof runtimeEnv !== 'object') {
		throw new Error(`${runtimeConfigPath} is missing "env.${envName}".`)
	}
	return envs as JsonRecord
}

function localizeRuntimeConfigMigrations(config: JsonRecord, envName: string) {
	const envs = config.env as JsonRecord
	const localizedTop = localizeMigrations(config.migrations)
	config.migrations = localizedTop
	for (const [name, runtimeEnv] of Object.entries(envs)) {
		if (!runtimeEnv || typeof runtimeEnv !== 'object') continue
		const envRecord = runtimeEnv as JsonRecord
		const localized = localizeMigrations(envRecord.migrations ?? localizedTop)
		envRecord.migrations = localized
		if (name === envName) {
			config.migrations = localized
		}
	}
}

/**
 * Wrangler 4.131+ applies the local sqlite-class map during `deploy --dry-run`
 * and on real deploy (container prep). The committed runtime production chain
 * transfers `PackageServiceInstance` then deletes it; wrangler ignores
 * `transferred_classes` in that map. Production `wrangler.jsonc` annotates v1
 * with `new_sqlite_classes: ["PackageServiceInstance"]` so live deploy passes.
 * These helpers still localize the full transfer chain for local sqlite
 * (dry-run / check startup). Do not use them as a production deploy config.
 */
export async function writeRuntimeDryRunConfig({
	runtimeConfigPath,
	envName,
}: {
	runtimeConfigPath: string
	envName: string
}) {
	const sourceText = await readFile(runtimeConfigPath, 'utf8')
	const config = parseJsonc<JsonRecord>(sourceText)
	requireRuntimeEnv(config, runtimeConfigPath, envName)
	localizeRuntimeConfigMigrations(config, envName)

	const outputPath = path.join(
		path.dirname(runtimeConfigPath),
		'wrangler-dry-run.generated.json',
	)
	await writeFile(outputPath, `${JSON.stringify(config, null, '\t')}\n`)
	return outputPath
}

/**
 * `wrangler check startup` runs an inner `deploy --dry-run` that ignores
 * `--config` and loads `wrangler.jsonc` from cwd. Write a localized snapshot
 * directory so that inner deploy does not see the production transfer-then-delete
 * chain. `main` is rewritten to an absolute path so the snapshot can live
 * outside `packages/runtime-worker`.
 */
export async function writeRuntimeStartupCheckConfig({
	runtimeConfigPath,
	envName,
	outputDir,
}: {
	runtimeConfigPath: string
	envName: string
	outputDir: string
}) {
	const sourceText = await readFile(runtimeConfigPath, 'utf8')
	const config = parseJsonc<JsonRecord>(sourceText)
	requireRuntimeEnv(config, runtimeConfigPath, envName)
	localizeRuntimeConfigMigrations(config, envName)
	if (typeof config.main === 'string') {
		config.main = path.resolve(path.dirname(runtimeConfigPath), config.main)
	}
	const outputPath = path.join(outputDir, 'wrangler.jsonc')
	await writeFile(outputPath, `${JSON.stringify(config, null, '\t')}\n`)
	return outputPath
}
