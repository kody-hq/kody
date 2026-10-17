import { expect, test } from 'vitest'
import {
	assertInactiveConfig,
	normalizeInactiveBuildConfig,
} from './start-opt-in-inactive-config.ts'

function emitted() {
	return {
		name: `kody-start-${'a'.repeat(40)}`,
		workers_dev: false,
		preview_urls: false,
		migrations: [],
		triggers: {},
		routes: [],
		custom_domains: [],
		email: [],
		env: {},
		unsafe: {},
		dispatch_namespaces: [],
		tail_consumers: [],
		streaming_tail_consumers: [],
		queues: {
			producers: [{ binding: 'QUEUE', queue: 'existing-production-queue' }],
			consumers: [],
		},
		d1_databases: [
			{
				binding: 'APP_DB',
				database_id: 'existing-production-db',
				migrations_dir: '../../packages/worker/migrations',
				migrations_table: 'd1_migrations',
				migrations_pattern: '*.sql',
			},
		],
		durable_objects: {
			bindings: [
				{ name: 'DO', class_name: 'Shared', script_name: 'kody-platform' },
			],
		},
		workflows: [
			{
				binding: 'WORKFLOW',
				name: 'existing-workflow',
				class_name: 'Workflow',
				script_name: 'kody-runtime',
			},
		],
		vars: {
			APP_BASE_URL: 'https://kody.codes',
			APP_COMMIT_SHA: 'a'.repeat(40),
		},
	}
}
test('canonicalizes source-confirmed inert Wrangler defaults without changing shared resource identities', () => {
	const raw = emitted()
	const result = normalizeInactiveBuildConfig(raw, raw.name)
	expect(() => assertInactiveConfig(result, raw.name)).not.toThrow()
	for (const key of [
		'migrations',
		'triggers',
		'routes',
		'custom_domains',
		'email',
		'env',
		'unsafe',
		'dispatch_namespaces',
		'tail_consumers',
		'streaming_tail_consumers',
	])
		expect(result[key]).toBeUndefined()
	expect(result.name).toBe(raw.name)
	expect(result.workers_dev).toBe(false)
	expect(result.preview_urls).toBe(false)
	expect(result.queues).toEqual({ producers: raw.queues.producers })
	expect(result.d1_databases).toEqual([
		{ binding: 'APP_DB', database_id: 'existing-production-db' },
	])
	expect(result.durable_objects).toEqual(raw.durable_objects)
	expect(result.workflows).toEqual(raw.workflows)
	expect(result.vars).toEqual(raw.vars)
	expect(raw.migrations).toEqual([])
	expect(raw.queues.consumers).toEqual([])
	expect(raw.d1_databases[0]!.migrations_dir).toContain('/migrations')
})
test('empty normalized cron list is inert, real cron and unknown triggers are rejected', () => {
	const raw = emitted()
	expect(
		normalizeInactiveBuildConfig({ ...raw, triggers: { crons: [] } }, raw.name)
			.triggers,
	).toBeUndefined()
	expect(() =>
		normalizeInactiveBuildConfig(
			{ ...raw, triggers: { crons: ['* * * * *'] } },
			raw.name,
		),
	).toThrow('triggers')
	expect(() =>
		normalizeInactiveBuildConfig(
			{ ...raw, triggers: { future_trigger: [] } },
			raw.name,
		),
	).toThrow('triggers')
})
test.each([
	{ key: 'migrations', value: [{ tag: 'v1', new_sqlite_classes: ['Owned'] }] },
	{ key: 'routes', value: [{ pattern: 'kody.codes/*' }] },
	{ key: 'route', value: 'kody.codes/*' },
	{ key: 'custom_domains', value: ['kody.codes'] },
	{ key: 'email', value: ['inbox@kody.codes'] },
	{ key: 'env', value: { production: { routes: ['kody.codes/*'] } } },
	{ key: 'unsafe', value: { bindings: [] } },
	{
		key: 'dispatch_namespaces',
		value: [{ binding: 'DISPATCH', namespace: 'owned' }],
	},
	{ key: 'tail_consumers', value: [{ service: 'another-worker' }] },
])(
	'never normalizes away nonempty ownership or ingress: $key',
	({ key, value }) => {
		const raw = emitted()
		expect(() =>
			normalizeInactiveBuildConfig({ ...raw, [key]: value }, raw.name),
		).toThrow(key)
	},
)
test('rejects real queue consumers and locally owned classes after normalization', () => {
	const raw = emitted()
	expect(() =>
		normalizeInactiveBuildConfig(
			{
				...raw,
				queues: {
					...raw.queues,
					consumers: [{ queue: 'existing-production-queue' }],
				},
			},
			raw.name,
		),
	).toThrow('queues.consumers')
	expect(() =>
		normalizeInactiveBuildConfig(
			{
				...raw,
				durable_objects: { bindings: [{ name: 'DO', class_name: 'Owned' }] },
			},
			raw.name,
		),
	).toThrow('durable_objects.bindings.script_name')
	expect(() =>
		normalizeInactiveBuildConfig(
			{
				...raw,
				workflows: [{ binding: 'FLOW', name: 'owned', class_name: 'Flow' }],
			},
			raw.name,
		),
	).toThrow('workflows.script_name')
})
test('diagnostics report field names only and never secret or binding values', () => {
	const raw = emitted()
	try {
		normalizeInactiveBuildConfig(
			{
				...raw,
				name: 'secret-looking-worker-value',
				workers_dev: true,
				routes: ['private-looking-route-value'],
			},
			raw.name,
		)
	} catch (error) {
		expect(String(error)).toContain('name, workers_dev, routes')
		expect(String(error)).not.toContain('secret-looking-worker-value')
		expect(String(error)).not.toContain('private-looking-route-value')
		return
	}
	throw new Error('Expected inactive config to be rejected')
})
