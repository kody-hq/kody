import { expect, test } from 'vitest'
import {
	buildStartRolloutConfig,
	assetManifestDigest,
	routerEntrySource,
	reviewedRouterName,
} from './start-rollout-config.ts'

function fixture() {
	return {
		production: {
			name: 'kody-production',
			main: './production-worker.ts',
			vars: {
				APP_BASE_URL: 'https://kody.codes',
				SENTRY_ENVIRONMENT: 'production',
			},
			d1_databases: [
				{
					binding: 'APP_DB',
					database_name: 'kody',
					database_id: 'existing-app-db',
					migrations_dir: './migrations',
				},
			],
			kv_namespaces: [{ binding: 'OAUTH_KV', id: 'existing-oauth-kv' }],
			r2_buckets: [
				{ binding: 'COMMUNITY_ASSETS', bucket_name: 'kody-community-assets' },
			],
			services: [
				{ binding: 'JOBS', service: 'kody-jobs', entrypoint: 'JobsService' },
			],
			durable_objects: {
				bindings: [
					{
						name: 'LOCAL',
						class_name: 'Local',
						script_name: 'kody-production',
					},
					{
						name: 'SHARED',
						class_name: 'Shared',
						script_name: 'kody-platform',
					},
				],
			},
			workflows: [
				{
					binding: 'WORKFLOW',
					name: 'existing-workflow',
					class_name: 'Flow',
					script_name: 'kody-production',
				},
			],
			queues: {
				producers: [{ binding: 'QUEUE', queue: 'kody-events' }],
				consumers: [{ queue: 'kody-events' }],
			},
			migrations: [{ tag: 'v1', new_sqlite_classes: ['Local'] }],
			triggers: { crons: ['* * * * *'] },
			routes: [{ pattern: 'kody.codes', custom_domain: true }],
			workers_dev: true,
		},
		routerBase: {
			name: 'kody-start-router',
			main: './index.ts',
			routes: ['kody.codes/*'],
		},
		release: 'a'.repeat(40),
		allowedPersonIds: ['b'.repeat(64), 'c'.repeat(64)],
		assetPaths: ['assets/start-hash.js', 'fonts/font.woff2'],
	}
}

test('candidate shares resolved production resources without taking infrastructure ownership', () => {
	const input = fixture()
	const result = buildStartRolloutConfig(input)
	expect(result.candidate.name).toBe(`kody-start-${input.release}`)
	expect(result.candidate.d1_databases).toEqual([
		{
			binding: 'APP_DB',
			database_name: 'kody',
			database_id: 'existing-app-db',
		},
	])
	expect(result.candidate.services).toEqual(input.production.services)
	expect(result.candidate.queues).toEqual({
		producers: input.production.queues.producers,
	})
	expect(result.candidate.durable_objects).toEqual({
		bindings: [
			{ name: 'LOCAL', class_name: 'Local', script_name: 'kody-production' },
			{ name: 'SHARED', class_name: 'Shared', script_name: 'kody-platform' },
		],
	})
	expect(result.candidate.workflows).toEqual([
		{
			binding: 'WORKFLOW',
			name: 'existing-workflow',
			class_name: 'Flow',
			script_name: 'kody-production',
		},
	])
	for (const key of ['routes', 'triggers', 'migrations', 'env'])
		expect(result.candidate[key]).toBeUndefined()
	expect(result.candidate.workers_dev).toBe(false)
	expect(result.router.routes).toBeUndefined()
	expect(result.router.workers_dev).toBe(false)
	expect(result.router.services).toEqual([
		{ binding: 'LEGACY', service: 'kody-production' },
		{ binding: 'START', service: `kody-start-${input.release}` },
	])
	expect(result.router.vars).toMatchObject({
		START_ALLOWED_PERSON_IDS: JSON.stringify(input.allowedPersonIds),
		START_ASSET_MANIFEST_SHA256: assetManifestDigest(input.assetPaths),
	})
	expect(result.manifest.activated).toBe(false)
	// The transform must not mutate its production input.
	expect(input.production.migrations).toHaveLength(1)
	expect(input.production.d1_databases[0]!.migrations_dir).toBe('./migrations')
})

test.each(['', 'short', 'A'.repeat(40)])(
	'rejects nonimmutable release %s',
	(release) => {
		expect(() => buildStartRolloutConfig({ ...fixture(), release })).toThrow(
			'full immutable',
		)
	},
)

test.each([
	{ allowedPersonIds: [] },
	{ allowedPersonIds: ['b'.repeat(64)] },
	{ allowedPersonIds: ['b'.repeat(64), 'b'.repeat(64)] },
	{ allowedPersonIds: ['tannerlinsley', 'kentcdodds'] },
])('requires exactly the approved stable IDs %j', ({ allowedPersonIds }) => {
	expect(() =>
		buildStartRolloutConfig({ ...fixture(), allowedPersonIds }),
	).toThrow('Exactly two')
})

test.each([
	'/assets/a.js',
	'../a.js',
	'assets/../a.js',
	'assets\\a.js',
	'assets/a.js?x=1',
	'_serverFn/read',
	'assets//a.js',
])('rejects unsafe asset path %s', (path) => {
	expect(() =>
		buildStartRolloutConfig({ ...fixture(), assetPaths: [path] }),
	).toThrow('exact emitted')
})

test('rejects unresolved or preview resources and plaintext secrets', () => {
	const input = fixture()
	input.production.d1_databases[0]!.database_id = ''
	expect(() => buildStartRolloutConfig(input)).toThrow('must be resolved')
	input.production.d1_databases[0]!.database_id = 'kody-pr-3561'
	expect(() => buildStartRolloutConfig(input)).toThrow('production')
	const secretInput = fixture()
	Object.assign(secretInput.production.vars, { COOKIE_SECRET: 'do-not-copy' })
	expect(() => buildStartRolloutConfig(secretInput)).toThrow(
		'Provision COOKIE_SECRET securely',
	)
})

test('selects production environment only and never copies preview environment bindings', () => {
	const input = fixture()
	const production = {
		...input.production,
		name: 'base-name',
		env: {
			production: input.production,
			preview: {
				d1_databases: [{ binding: 'APP_DB', database_id: 'preview-db' }],
			},
		},
	}
	const result = buildStartRolloutConfig({ ...input, production })
	expect(result.manifest.legacyName).toBe('kody-production')
	expect(result.candidate.env).toBeUndefined()
	expect(JSON.stringify(result)).not.toContain('preview-db')
})

test('rejects unresolved durable object and workflow ownership', () => {
	const input = fixture()
	delete (
		input.production.durable_objects.bindings[0] as Record<string, unknown>
	).script_name
	expect(() => buildStartRolloutConfig(input)).toThrow(
		'durable object script_name must be resolved',
	)
	const workflowInput = fixture()
	delete (workflowInput.production.workflows[0] as Record<string, unknown>)
		.script_name
	expect(() => buildStartRolloutConfig(workflowInput)).toThrow(
		'workflow script_name must be resolved',
	)
})

test.each([
	'assets/%61.js',
	'assets/a b.js',
	'assets/a\n.js',
	'assets/a\t.js',
	'assets/a\x7f.js',
])('rejects asset paths the router cannot serve: %s', (path) => {
	expect(() =>
		buildStartRolloutConfig({ ...fixture(), assetPaths: [path] }),
	).toThrow('exact emitted')
})

test.each([
	'kody-production',
	`kody-start-${'a'.repeat(40)}`,
	'other-worker',
	'',
])('rejects unsafe router worker name %s', (name) => {
	const input = fixture()
	input.routerBase.name = name
	expect(() => buildStartRolloutConfig(input)).toThrow(
		'router worker must be kody-start-router',
	)
})

test('requires the existing legacy production worker by exact name', () => {
	const input = fixture()
	input.production.name = 'another-production'
	expect(() => buildStartRolloutConfig(input)).toThrow(
		'legacy worker must be kody-production',
	)
})

test('candidate reports its exact source release without carrying legacy deployment metadata', () => {
	const input = fixture()
	Object.assign(input.production.vars, {
		APP_COMMIT_SHA: 'd'.repeat(40),
		APP_DEPLOY_INFO: 'legacy-deployment-info',
	})
	const result = buildStartRolloutConfig(input)
	expect(result.candidate.vars).toMatchObject({ APP_COMMIT_SHA: input.release })
	expect(
		(result.candidate.vars as Record<string, unknown>).APP_DEPLOY_INFO,
	).toBeUndefined()
	expect(
		(input.production.vars as Record<string, unknown>).APP_DEPLOY_INFO,
	).toBe('legacy-deployment-info')
})

test('embeds a large exact manifest in source and keeps text bindings small', () => {
	const input = fixture()
	input.assetPaths = Array.from(
		{ length: 500 },
		(_, i) => `assets/chunk-${i}-${'a'.repeat(100)}.js`,
	)
	const result = buildStartRolloutConfig(input)
	expect(JSON.stringify(result.router.vars).length).toBeLessThan(5120)
	expect(result.router.main).toBe('./start-entry.generated.ts')
	const source = routerEntrySource(input.release, input.assetPaths)
	for (const path of input.assetPaths)
		expect(source).toContain(JSON.stringify(path))
	expect(assetManifestDigest(input.assetPaths)).toBe(
		assetManifestDigest([...input.assetPaths].reverse()),
	)
	expect(assetManifestDigest(input.assetPaths)).not.toBe(
		assetManifestDigest(input.assetPaths.slice(1)),
	)
})

test('router names are immutable per release and missing or mismatched names fail closed', () => {
	const release = 'a'.repeat(40)
	expect(reviewedRouterName(release, `kody-start-router-${release}`)).toBe(
		`kody-start-router-${release}`,
	)
	expect(() => reviewedRouterName(release)).toThrow('exact reviewed release')
	expect(() =>
		reviewedRouterName(release, `kody-start-router-${'b'.repeat(40)}`),
	).toThrow('exact reviewed release')
	expect(() => reviewedRouterName(release, 'kody-start-router')).toThrow(
		'exact reviewed release',
	)
	const bundle = buildStartRolloutConfig(fixture())
	expect(bundle.router.name).toBe(`kody-start-router-${release}`)
	expect(bundle.manifest.routerName).toBe(bundle.router.name)
})
