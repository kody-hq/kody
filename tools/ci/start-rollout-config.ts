import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { parseJsonc } from './resource-utils.ts'
import { isExecutedDirectly } from '../node-runtime.ts'

type Config = Record<string, unknown>
function record(value: unknown, label: string): Config {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error(`${label} must be an object`)
	return value as Config
}
function entries(value: unknown, label: string): Array<Config> {
	if (value === undefined) return []
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
	return value.map((entry) => record(entry, label))
}
function required(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim())
		throw new Error(`${label} must be resolved`)
	if (/preview|pr-\d+|unconfigured|placeholder|<|>/i.test(value))
		throw new Error(`${label} must reference production`)
	return value
}

export function reviewedRouterName(release: string, declared?: unknown) {
	if (!/^[a-f0-9]{40}$/.test(release))
		throw new Error('Exact router release required')
	const expected = `kody-start-router-${release}`
	if (declared === expected) return expected
	throw new Error('Router name must pin exact reviewed release')
}

export function assetManifestDigest(assetPaths: readonly string[]) {
	return createHash('sha256')
		.update(JSON.stringify([...assetPaths].sort()))
		.digest('hex')
}

export function routerEntrySource(
	release: string,
	assetPaths: readonly string[],
) {
	const manifest = {
		release,
		assetPaths: [...assetPaths].sort(),
		digest: assetManifestDigest(assetPaths),
	}
	return `import { createRoutingWorker } from './index.ts'\nexport default createRoutingWorker(${JSON.stringify(manifest)})\n`
}

/** Pure config transform. It never ensures resources, runs migrations or deploys. */
export function buildStartRolloutConfig(input: {
	production: Config
	routerBase: Config
	release: string
	allowedPersonIds: Array<string>
	assetPaths: Array<string>
}) {
	if (!/^[a-f0-9]{40}$/.test(input.release))
		throw new Error('A full immutable release SHA is required')
	if (
		input.allowedPersonIds.length !== 2 ||
		new Set(input.allowedPersonIds).size !== 2 ||
		input.allowedPersonIds.some((id) => !/^[a-f0-9]{64}$/.test(id))
	)
		throw new Error(
			'Exactly two distinct approved stable person IDs are required',
		)
	if (
		!input.assetPaths.length ||
		new Set(input.assetPaths).size !== input.assetPaths.length ||
		input.assetPaths.some(
			(path) =>
				!path ||
				path.startsWith('/') ||
				// Reject whitespace and controls before URL normalization.
				// eslint-disable-next-line no-control-regex
				/[%\\?#\x00-\x20\x7f]/.test(path) ||
				path
					.split('/')
					.some((part) => !part || part === '.' || part === '..') ||
				path === '_serverFn' ||
				path.startsWith('_serverFn/'),
		)
	)
		throw new Error('Supply exact emitted release-relative asset paths')
	const production = structuredClone(input.production)
	const selected =
		production.env === undefined
			? production
			: {
					...production,
					...record(record(production.env, 'env').production, 'env.production'),
				}
	delete selected.env
	const legacyName = required(selected.name, 'production worker name')
	if (legacyName !== 'kody-production')
		throw new Error('The legacy worker must be kody-production')
	const vars = record(selected.vars, 'production vars')
	if (vars.APP_BASE_URL !== 'https://kody.codes')
		throw new Error('Production APP_BASE_URL must be https://kody.codes')
	if (vars.SENTRY_ENVIRONMENT !== 'production')
		throw new Error('Only an existing production config is accepted')
	// Secrets are write-only in Cloudflare. A config must never pretend they were copied.
	for (const key of Object.keys(vars)) {
		if (/SECRET|PRIVATE_KEY|TOKEN|PASSWORD/.test(key) && vars[key])
			throw new Error(`Provision ${key} securely, not through generated vars`)
	}
	for (const [section, field] of [
		['d1_databases', 'database_id'],
		['kv_namespaces', 'id'],
		['r2_buckets', 'bucket_name'],
		['vectorize', 'index_name'],
		['services', 'service'],
		['analytics_engine_datasets', 'dataset'],
	] as const) {
		for (const entry of entries(selected[section], section)) {
			required(entry[field], `${section}.${field}`)
			delete entry.migrations_dir
			delete entry.migrations_table
			delete entry.preview_database_id
			delete entry.preview_id
			delete entry.preview_bucket_name
		}
	}
	const databases = entries(selected.d1_databases, 'd1_databases')
	const appDb = databases.find((entry) => entry.binding === 'APP_DB')
	if (!appDb) throw new Error('Resolved production APP_DB is required')
	for (const binding of entries(
		record(selected.durable_objects ?? {}, 'durable_objects').bindings,
		'durable_objects.bindings',
	)) {
		// Ownership must already be external in the resolved production config.
		binding.script_name = required(
			binding.script_name,
			'durable object script_name',
		)
	}
	for (const workflow of entries(selected.workflows, 'workflows')) {
		workflow.script_name = required(
			workflow.script_name,
			'workflow script_name',
		)
	}
	const queues = record(selected.queues ?? {}, 'queues')
	for (const producer of entries(queues.producers, 'queues.producers'))
		required(producer.queue, 'queue producer')
	selected.queues = { producers: queues.producers ?? [] }
	for (const key of [
		'routes',
		'route',
		'custom_domains',
		'triggers',
		'migrations',
		'email',
		'dispatch_namespaces',
		'tail_consumers',
		'unsafe',
	])
		delete selected[key]
	const candidateName = `kody-start-${input.release}`
	selected.name = candidateName
	selected.vars = { ...vars, APP_COMMIT_SHA: input.release }
	delete (selected.vars as Config).APP_DEPLOY_INFO
	selected.workers_dev = false
	selected.preview_urls = false
	const router = structuredClone(input.routerBase)
	if (
		router.name === legacyName ||
		router.name === candidateName ||
		router.name !== 'kody-start-router'
	)
		throw new Error(
			'The router worker must be kody-start-router and must not replace either origin worker',
		)
	for (const key of [
		'env',
		'routes',
		'route',
		'custom_domains',
		'triggers',
		'migrations',
		'queues',
		'email',
		'durable_objects',
		'workflows',
		'unsafe',
	])
		delete router[key]
	const routerName = `kody-start-router-${input.release}`
	router.name = routerName
	router.workers_dev = false
	router.preview_urls = false
	router.services = [
		{ binding: 'LEGACY', service: legacyName },
		{ binding: 'START', service: candidateName },
	]
	router.d1_databases = [
		{
			binding: 'APP_DB',
			database_name: appDb.database_name,
			database_id: appDb.database_id,
		},
	]
	router.main = './start-entry.generated.ts'
	router.vars = {
		APP_BASE_URL: vars.APP_BASE_URL,
		START_RELEASE: input.release,
		START_ALLOWED_PERSON_IDS: JSON.stringify(input.allowedPersonIds),
		START_ASSET_MANIFEST_SHA256: assetManifestDigest(input.assetPaths),
	}
	return {
		candidate: selected,
		router,
		manifest: {
			release: input.release,
			candidateName,
			routerName,
			legacyName,
			origin: vars.APP_BASE_URL,
			activationRoute: 'kody.codes/*',
			activated: false,
			allowedPersonIds: input.allowedPersonIds,
			assetPaths: input.assetPaths,
			secretProvisioning:
				'Supply the existing production secrets from their trusted source. Cloudflare cannot return secret values. Candidate COOKIE_SECRET and encryption keys must match production. Router COOKIE_SECRET must match production, START_ROLLOUT_SECRET must be distinct and at least 32 characters. Do not rotate live secrets.',
		},
	}
}

if (isExecutedDirectly(import.meta.url)) {
	const [
		productionPath,
		routerPath,
		release,
		peoplePath,
		assetsPath,
		outputPath,
	] = process.argv.slice(2)
	if (
		!productionPath ||
		!routerPath ||
		!release ||
		!peoplePath ||
		!assetsPath ||
		!outputPath
	)
		throw new Error(
			'Usage: start-rollout-config.ts production.json router.jsonc full-sha approved-person-ids.json asset-paths.json output.json',
		)
	const result = buildStartRolloutConfig({
		production: parseJsonc<Config>(await readFile(productionPath, 'utf8')),
		routerBase: parseJsonc<Config>(await readFile(routerPath, 'utf8')),
		release,
		allowedPersonIds: JSON.parse(
			await readFile(peoplePath, 'utf8'),
		) as Array<string>,
		assetPaths: JSON.parse(await readFile(assetsPath, 'utf8')) as Array<string>,
	})
	await writeFile(outputPath, `${JSON.stringify(result, null, '\t')}\n`, {
		mode: 0o600,
	})
}
