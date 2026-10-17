import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseJsonc } from './resource-utils.ts'
import { normalizeInactiveBuildConfig } from './start-opt-in-inactive-config.ts'
import {
	buildStartRolloutConfig,
	routerEntrySource,
} from './start-rollout-config.ts'
import { isExecutedDirectly } from '../node-runtime.ts'

type RecordValue = Record<string, unknown>
function object(value: unknown): RecordValue {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Expected object')
	return value as RecordValue
}

/** Map only supported live bindings. Unknown bindings must receive explicit review. */
export function mapLiveProductionSettings(
	base: RecordValue,
	settings: RecordValue,
) {
	const selected = { ...base, ...object(object(base.env).production) }
	delete selected.env
	selected.name = 'kody-production'
	selected.main = './src/production-worker.ts'
	for (const key of [
		'vars',
		'd1_databases',
		'kv_namespaces',
		'r2_buckets',
		'services',
		'durable_objects',
		'workflows',
		'queues',
		'vectorize',
		'analytics_engine_datasets',
		'ratelimits',
		'worker_loaders',
		'send_email',
		'artifacts',
		'ai',
		'images',
		'version_metadata',
	])
		delete selected[key]
	selected.vars = {}
	if (!Array.isArray(settings.bindings))
		throw new Error('Live settings bindings are missing')
	const append = (section: string, value: RecordValue) => {
		const entries = (selected[section] ?? []) as Array<RecordValue>
		entries.push(value)
		selected[section] = entries
	}
	for (const value of settings.bindings) {
		const binding = object(value)
		const name = binding.name
		if (typeof name !== 'string' || !name)
			throw new Error('Live binding name is missing')
		switch (binding.type) {
			case 'secret_text':
				break
			case 'plain_text':
				object(selected.vars)[name] = binding.text
				break
			case 'json':
				object(selected.vars)[name] = binding.json
				break
			case 'd1':
				append('d1_databases', { binding: name, database_id: binding.id })
				break
			case 'kv_namespace':
				append('kv_namespaces', { binding: name, id: binding.namespace_id })
				break
			case 'r2_bucket':
				append('r2_buckets', {
					binding: name,
					bucket_name: binding.bucket_name,
					jurisdiction: binding.jurisdiction,
				})
				break
			case 'service':
				append('services', {
					binding: name,
					service: binding.service,
					environment: binding.environment,
					entrypoint: binding.entrypoint,
				})
				break
			case 'durable_object_namespace': {
				const durable = object(selected.durable_objects ?? { bindings: [] })
				;(durable.bindings as Array<RecordValue>).push({
					name,
					class_name: binding.class_name,
					script_name: binding.script_name,
					environment: binding.environment,
				})
				selected.durable_objects = durable
				break
			}
			case 'workflow':
				append('workflows', {
					binding: name,
					name: binding.workflow_name,
					class_name: binding.class_name,
					script_name: binding.script_name,
				})
				break
			case 'queue': {
				const queues = object(selected.queues ?? { producers: [] })
				;(queues.producers as Array<RecordValue>).push({
					binding: name,
					queue: binding.queue_name,
					delivery_delay: binding.delivery_delay,
				})
				selected.queues = queues
				break
			}
			case 'vectorize':
				append('vectorize', { binding: name, index_name: binding.index_name })
				break
			case 'analytics_engine':
				append('analytics_engine_datasets', {
					binding: name,
					dataset: binding.dataset,
				})
				break
			case 'ratelimit':
				append('ratelimits', {
					name,
					namespace_id: binding.namespace_id,
					simple: binding.simple,
				})
				break
			case 'worker_loader':
				append('worker_loaders', { binding: name })
				break
			case 'artifacts':
				append('artifacts', { binding: name, namespace: binding.namespace })
				break
			case 'send_email':
				append('send_email', {
					name,
					destination_address: binding.destination_address,
					allowed_destination_addresses: binding.allowed_destination_addresses,
					allowed_sender_addresses: binding.allowed_sender_addresses,
				})
				break
			case 'ai':
			case 'images':
			case 'version_metadata':
				selected[binding.type] = { binding: name }
				break
			case 'assets':
				break // The candidate must build its own assets, never reuse live assets.
			default:
				throw new Error(
					`Unsupported live binding type: ${String(binding.type)}`,
				)
		}
	}
	for (const key of ['compatibility_date', 'compatibility_flags']) {
		if (settings[key] !== undefined) selected[key] = settings[key]
	}
	return selected
}

export function approvedPeople(rows: Array<RecordValue>) {
	const names = ['tannerlinsley', 'kentcdodds']
	if (
		rows.length !== 2 ||
		names.some(
			(name) => rows.filter((row) => row.username === name).length !== 1,
		)
	)
		throw new Error('Both exact approved accounts must exist')
	const ids = names.map(
		(name) => rows.find((row) => row.username === name)!.stable_user_id,
	)
	if (
		ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) ||
		new Set(ids).size !== 2
	)
		throw new Error('Approved stable IDs must be distinct 64 character hex IDs')
	return ids as Array<string>
}

async function api(endpoint: string, body?: RecordValue) {
	const token = process.env.CLOUDFLARE_API_TOKEN
	const account = process.env.CLOUDFLARE_ACCOUNT_ID
	if (!token || !account || !/^[a-f0-9]{32}$/.test(account))
		throw new Error('Cloudflare read credentials are required')
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${account}/${endpoint}`,
		{
			method: body ? 'POST' : 'GET',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		},
	)
	const result = object(await response.json())
	if (!response.ok || result.success !== true)
		throw new Error(`Cloudflare read failed (${response.status})`)
	return result.result
}

async function emittedAssets(
	directory: string,
	prefix = '',
): Promise<Array<string>> {
	const entries = await readdir(directory, { withFileTypes: true })
	return (
		await Promise.all(
			entries.map(async (entry) => {
				const relative = `${prefix}${entry.name}`
				if (entry.isSymbolicLink())
					throw new Error('Asset symlinks are forbidden')
				return entry.isDirectory()
					? emittedAssets(path.join(directory, entry.name), `${relative}/`)
					: [relative]
			}),
		)
	)
		.flat()
		.sort()
}

if (isExecutedDirectly(import.meta.url)) {
	const release = process.env.KODY_START_RELEASE ?? ''
	if (!/^[a-f0-9]{40}$/.test(release))
		throw new Error('Pinned release required')
	const directory = '.tmp/start-opt-in'
	await mkdir(directory, { recursive: true })
	const routerBase = parseJsonc<RecordValue>(
		await readFile('packages/start-routing-worker/wrangler.jsonc', 'utf8'),
	)
	if (process.argv[2] === 'snapshot') {
		const base = parseJsonc<RecordValue>(
			await readFile('packages/worker/wrangler.jsonc', 'utf8'),
		)
		const settings = object(
			await api('workers/scripts/kody-production/settings'),
		)
		const production = mapLiveProductionSettings(base, settings)
		const app = (production.d1_databases as Array<RecordValue>).find(
			(binding) => binding.binding === 'APP_DB',
		)
		if (
			!app ||
			typeof app.database_id !== 'string' ||
			!/^[a-f0-9-]{36}$/.test(app.database_id)
		)
			throw new Error('Resolved APP_DB required')
		const query = await api(`d1/database/${app.database_id}/query`, {
			sql: 'SELECT username, stable_user_id FROM users WHERE username IN (?, ?) AND suspended_at IS NULL AND deleting_at IS NULL AND deleted_at IS NULL',
			params: ['tannerlinsley', 'kentcdodds'],
		})
		if (!Array.isArray(query) || query.length !== 1)
			throw new Error('Unexpected SELECT response')
		const queryResult = object(query[0])
		if (queryResult.success !== true || !Array.isArray(queryResult.results))
			throw new Error('Approved account SELECT failed')
		const people = approvedPeople(queryResult.results.map(object))
		// A temporary safe manifest lets the pure transform validate resources before building.
		const bundle = buildStartRolloutConfig({
			production,
			routerBase,
			release,
			allowedPersonIds: people,
			assetPaths: ['build-pending.js'],
		})
		await writeFile(`${directory}/production.json`, JSON.stringify(production))
		await writeFile(
			`${directory}/secret-names.json`,
			JSON.stringify(
				(settings.bindings as Array<RecordValue>)
					.filter((binding) => binding.type === 'secret_text')
					.map((binding) => binding.name),
			),
		)
		await writeFile(`${directory}/people.json`, JSON.stringify(people))
		await writeFile(
			'packages/worker/wrangler-start.generated.json',
			JSON.stringify({
				...bundle.candidate,
				env: { production: bundle.candidate },
			}),
		)
	} else if (process.argv[2] === 'finalize') {
		const production = object(
			JSON.parse(await readFile(`${directory}/production.json`, 'utf8')),
		)
		const people = JSON.parse(
			await readFile(`${directory}/people.json`, 'utf8'),
		) as Array<string>
		const assetPaths = await emittedAssets(`dist/client/__start/${release}`)
		const bundle = buildStartRolloutConfig({
			production,
			routerBase,
			release,
			allowedPersonIds: people,
			assetPaths,
		})
		await writeFile(
			'packages/start-routing-worker/start-entry.generated.ts',
			routerEntrySource(release, assetPaths),
		)
		const built = normalizeInactiveBuildConfig(
			object(JSON.parse(await readFile('dist/server/wrangler.json', 'utf8'))),
			String(bundle.candidate.name),
		)
		await writeFile(
			'dist/server/wrangler.json',
			JSON.stringify(built, null, '\t'),
		)
		await writeFile(
			`${directory}/review.json`,
			JSON.stringify(bundle, null, '\t'),
		)
		await writeFile(
			`${directory}/router.json`,
			JSON.stringify(bundle.router, null, '\t'),
		)
	} else throw new Error('Use snapshot or finalize')
}
