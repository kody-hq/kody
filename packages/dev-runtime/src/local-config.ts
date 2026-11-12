/**
 * Turns the production Wrangler configs of the real Kody workers into local
 * `kody dev` configs. Only system boundaries change: bindings that are always
 * remote (AI, Artifacts, Vectorize, Images) are removed, production vars are
 * replaced with local ones, and cron triggers are dropped so jobs only run
 * when `kody dev --run-jobs` asks for them.
 */

import { localizeMigrations } from '../../../tools/local-dev-migrations.ts'

type JsonObject = Record<string, unknown>

export const localWorkerNames = [
	'origin',
	'platform',
	'runtime',
	'jobs',
	'highlight',
] as const

export type LocalWorkerName = (typeof localWorkerNames)[number]

/** Bindings that only exist on Cloudflare and have no local simulator. */
export const alwaysRemoteBindingKeys = [
	'ai',
	'artifacts',
	'vectorize',
	'images',
] as const

const droppedKeys = [
	...alwaysRemoteBindingKeys,
	'$schema',
	'env',
	'routes',
	'route',
	'build',
	'alias',
	'triggers',
	'observability',
	'upload_source_maps',
	'tail_consumers',
	'logpush',
	'dev',
	'preview_urls',
	'workers_dev',
	'account_id',
] as const

/**
 * Production vars that point at real external systems (backups, billing,
 * analytics, error reporting). Local runs never set them.
 */
const productionOnlyVarPattern =
	/^(DR_|BACKUP_|STRIPE_|SENTRY_|FATHOM_|YOUTUBE_|SOFT_DELETE_)/

const localVars: Readonly<Record<string, string>> = {
	WRANGLER_IS_LOCAL_DEV: 'true',
	// Package secrets resolve to placeholders; the secret store is never read.
	KODY_DEV_MOCK_SECRETS: 'true',
	ARTIFACTS_NAMESPACE: 'local',
	USER_EMAIL_DOMAIN: 'inbox.kody.localhost',
	SYSTEM_EMAIL_DOMAIN: 'kody.localhost',
}

const moduleRules = [
	{ type: 'CompiledWasm', globs: ['**/*.wasm'] },
	{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] },
	{ type: 'Text', globs: ['**/*.txt', '**/*.md', '**/*.html', '**/*.css'] },
	{ type: 'Data', globs: ['**/*.bin', '**/*.ttf', '**/*.png'] },
]

function isEmpty(value: unknown) {
	if (value === null || value === undefined) return true
	if (Array.isArray(value)) return value.length === 0
	if (typeof value === 'object') return Object.keys(value).length === 0
	return false
}

function localizeVars(vars: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	if (vars && typeof vars === 'object') {
		for (const [key, value] of Object.entries(vars)) {
			if (productionOnlyVarPattern.test(key)) continue
			if (key === 'PACKAGE_APP_BASE_URL') continue
			out[key] = value
		}
	}
	return { ...out, ...localVars }
}

/**
 * Flatten `env.production` over the top-level config, as `wrangler deploy
 * --env production` does, then localize the result.
 */
export function flattenProductionConfig(source: JsonObject): JsonObject {
	const env = (source.env as JsonObject | undefined) ?? {}
	const production = (env.production as JsonObject | undefined) ?? {}
	return { ...source, ...production, name: source.name }
}

export function createLocalWorkerConfig(input: {
	worker: LocalWorkerName
	/** Production config: `dist/server/wrangler.json` or a flattened jsonc. */
	config: JsonObject
	main: string
	/** Origin only: relative path to the built client assets. */
	assetsDirectory?: string
	/** `migrations_dir` per D1 binding, relative to the generated config. */
	d1MigrationsDirs?: Readonly<Record<string, string>>
}): JsonObject {
	const out: JsonObject = { ...input.config }
	for (const key of droppedKeys) delete out[key]
	for (const [key, value] of Object.entries(out)) {
		if (isEmpty(value)) delete out[key]
	}
	out.main = input.main
	out.no_bundle = true
	out.find_additional_modules = true
	out.rules = moduleRules
	out.vars = localizeVars(input.config.vars)
	// The origin binds Durable Objects that live on platform and runtime and
	// keeps its production migration history; only owners localize.
	if (input.worker !== 'origin') {
		out.migrations = localizeMigrations(out.migrations)
	}
	if (input.assetsDirectory) {
		const assets = (input.config.assets as JsonObject | undefined) ?? {}
		out.assets = { ...assets, directory: input.assetsDirectory }
	}
	if (Array.isArray(out.d1_databases)) {
		out.d1_databases = (out.d1_databases as Array<JsonObject>).map((db) => {
			const binding = String(db.binding)
			const next: JsonObject = {
				binding,
				database_name: db.database_name,
				database_id: `local-${binding.toLowerCase()}`,
			}
			const dir = input.d1MigrationsDirs?.[binding]
			if (dir) next.migrations_dir = dir
			return next
		})
	}
	if (Array.isArray(out.kv_namespaces)) {
		out.kv_namespaces = (out.kv_namespaces as Array<JsonObject>).map((kv) => ({
			binding: kv.binding,
			id: `local-${String(kv.binding)}`,
		}))
	}
	return out
}

/**
 * Bindings the generated config removed. The CI guard reads this to prove
 * every hosted binding is either local or a named boundary mock.
 */
export function droppedBindingKeys(config: JsonObject): Array<string> {
	return alwaysRemoteBindingKeys.filter((key) => !isEmpty(config[key]))
}
