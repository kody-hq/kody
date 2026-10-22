import { readFile } from 'node:fs/promises'
import { writeGeneratedConfig } from './write-generated-config.ts'
import path from 'node:path'
import { parseJsonc } from './ci/resource-utils.ts'
import { localizeMigrations } from './local-dev-migrations.ts'

type JsonRecord = Record<string, unknown>

/**
 * Builds a local-dev variant of a Vite auxiliary worker (jobs or highlight).
 * Wrangler registers each `--env` worker as `<name>-<env>`, so the committed
 * `kody-jobs` / `kody-highlight` configs resolve as `kody-jobs-production`
 * while origin still binds `service: "kody-jobs"`. Pin the registered name to
 * the committed worker name, localize Durable Object migrations, and point
 * HOST back at the origin's local name.
 */
export async function writeLocalAuxiliaryDevConfig({
	configPath,
	envName,
	mainWorkerDevName,
	generatedBasename = 'wrangler-local-dev.generated.json',
}: {
	configPath: string
	envName: string
	mainWorkerDevName: string
	generatedBasename?: string
}) {
	const sourceText = await readFile(configPath, 'utf8')
	const config = parseJsonc<JsonRecord>(sourceText)
	const envs = config.env
	if (!envs || typeof envs !== 'object') {
		throw new Error(`${configPath} is missing "env".`)
	}
	const auxiliaryEnv = (envs as JsonRecord)[envName]
	if (!auxiliaryEnv || typeof auxiliaryEnv !== 'object') {
		throw new Error(`${configPath} is missing "env.${envName}".`)
	}
	const envRecord = auxiliaryEnv as JsonRecord

	// Production local serve registers `<name>-production` unless we pin
	// `env.production.name` to the committed worker name. The test env already
	// matches origin (`kody-jobs-test` / `kody-highlight-test`); pinning there
	// would break Playwright.
	if (envName !== 'test') {
		envRecord.name = config.name
	}

	const services = envRecord.services
	if (Array.isArray(services)) {
		for (const binding of services) {
			if (!binding || typeof binding !== 'object') continue
			const record = binding as JsonRecord
			if (record.binding === 'HOST') {
				record.service = mainWorkerDevName
			}
		}
	}

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

	const outputPath = path.join(path.dirname(configPath), generatedBasename)
	await writeGeneratedConfig(
		outputPath,
		`${JSON.stringify(config, null, '\t')}\n`,
	)
	return outputPath
}
