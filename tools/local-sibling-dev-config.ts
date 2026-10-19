import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseJsonc } from './ci/resource-utils.ts'
import { localizeMigrations } from './local-dev-migrations.ts'

type JsonRecord = Record<string, unknown>

/**
 * Builds a local-dev variant of a sibling worker config (platform or runtime)
 * for multi-config `wrangler dev`. Wrangler applies `--var` and dotenv-derived
 * values only to the primary config, registers each worker under
 * `<name>-<env>`, and treats a secondary config's always-remote bindings
 * (`ai`, and for platform `artifacts`) as remote-only — so the committed
 * sibling config cannot be passed to `wrangler dev` as-is. The generated
 * config pins the registered name to the committed worker name so origin
 * cross-script references resolve, drops the named always-remote bindings,
 * rewrites Durable Object `script_name: "kody"` refs to the primary's local
 * name, and injects required vars from the dev process environment.
 */
export async function writeLocalSiblingDevConfig({
	configPath,
	envName,
	mainWorkerDevName,
	port,
	generatedBasename = 'wrangler-local-dev.generated.json',
	dropAlwaysRemoteBindings = ['ai'],
}: {
	configPath: string
	envName: string
	mainWorkerDevName: string
	port: string | undefined
	generatedBasename?: string
	dropAlwaysRemoteBindings?: ReadonlyArray<string>
}) {
	const sourceText = await readFile(configPath, 'utf8')
	const config = parseJsonc<JsonRecord>(sourceText)
	const envs = config.env
	if (!envs || typeof envs !== 'object') {
		throw new Error(`${configPath} is missing "env".`)
	}
	const siblingEnv = (envs as JsonRecord)[envName]
	if (!siblingEnv || typeof siblingEnv !== 'object') {
		throw new Error(`${configPath} is missing "env.${envName}".`)
	}
	const envRecord = siblingEnv as JsonRecord

	// Pin the registered dev name to the committed worker name so origin
	// (and peer sibling) `script_name` / `service` references resolve.
	envRecord.name = config.name

	for (const binding of dropAlwaysRemoteBindings) {
		delete envRecord[binding]
	}

	const durableObjects = envRecord.durable_objects
	if (durableObjects && typeof durableObjects === 'object') {
		const bindings = (durableObjects as JsonRecord).bindings
		if (Array.isArray(bindings)) {
			for (const binding of bindings) {
				if (!binding || typeof binding !== 'object') continue
				const record = binding as JsonRecord
				if (record.script_name === 'kody') {
					record.script_name = mainWorkerDevName
				}
			}
		}
	}

	// Wrangler builds the local sqlite-class map from top-level migrations
	// even when `--env` is set. Put the rewritten chain there (and on the
	// env block so inherit/override both stay consistent).
	const localized = localizeMigrations(
		envRecord.migrations ?? config.migrations,
	)
	config.migrations = localized
	envRecord.migrations = localized

	const vars =
		envRecord.vars && typeof envRecord.vars === 'object'
			? (envRecord.vars as JsonRecord)
			: {}
	envRecord.vars = vars
	vars.WRANGLER_IS_LOCAL_DEV = 'true'
	if (port) {
		vars.APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${port}`
	} else if (process.env.APP_BASE_URL) {
		vars.APP_BASE_URL = process.env.APP_BASE_URL
	}
	for (const key of ['COOKIE_SECRET', 'SECRET_STORE_KEY']) {
		const value = process.env[key]
		if (value) vars[key] = value
	}

	const outputPath = path.join(path.dirname(configPath), generatedBasename)
	await writeFile(outputPath, `${JSON.stringify(config, null, '\t')}\n`)
	return outputPath
}
