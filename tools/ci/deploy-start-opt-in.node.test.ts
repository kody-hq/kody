import { assertInactiveConfig } from './start-opt-in-inactive-config.ts'
import { expect, test } from 'vitest'
import {
	assertProductionSnapshot,
	assertBindingSizes,
	assertSharedBindings,
	collectCandidateSecrets,
	inactiveDeployInvocation,
} from './deploy-start-opt-in.ts'

const turnstileKeys = {
	TURNSTILE_SITE_KEY: 'trusted-site-key',
	TURNSTILE_SECRET_KEY: 'trusted-secret-key',
}
const inactive = () => ({
	name: 'kody-start-router',
	workers_dev: false,
	preview_urls: false,
})
test('rejects ingress, schema and resource ownership changes', () => {
	expect(() =>
		assertInactiveConfig(inactive(), 'kody-start-router'),
	).not.toThrow()
	for (const key of ['routes', 'migrations', 'triggers', 'env', 'unsafe'])
		expect(() =>
			assertInactiveConfig({ ...inactive(), [key]: [] }, 'kody-start-router'),
		).toThrow(key)
	expect(() =>
		assertInactiveConfig(
			{ ...inactive(), queues: { consumers: [] } },
			'kody-start-router',
		),
	).toThrow('queues.consumers')
	expect(() =>
		assertInactiveConfig(
			{
				...inactive(),
				durable_objects: { bindings: [{ name: 'DO', class_name: 'Local' }] },
			},
			'kody-start-router',
		),
	).toThrow('durable_objects.bindings.script_name')
	expect(() => assertInactiveConfig(inactive(), 'kody-production')).toThrow(
		'name',
	)
})
test('requires trusted cookie and encryption secrets and rejects unknown live secret mappings', () => {
	expect(() => collectCandidateSecrets([], {})).toThrow('COOKIE_SECRET')
	expect(() =>
		collectCandidateSecrets([], { ...turnstileKeys, COOKIE_SECRET: 'cookie' }),
	).toThrow('SECRET_STORE_KEY')
	expect(() =>
		collectCandidateSecrets(['UNKNOWN'], {
			...turnstileKeys,
			COOKIE_SECRET: 'cookie',
			SECRET_STORE_KEY: 'store',
		}),
	).toThrow('reviewed secret mapping')
	expect(() =>
		collectCandidateSecrets(['STRIPE_SECRET_KEY'], {
			...turnstileKeys,
			COOKIE_SECRET: 'cookie',
			SECRET_STORE_KEY: 'store',
		}),
	).toThrow('STRIPE_SECRET_KEY')
	expect(
		collectCandidateSecrets(['CLOUDFLARE_API_TOKEN'], {
			...turnstileKeys,
			COOKIE_SECRET: 'cookie',
			SECRET_STORE_KEY: 'store',
			CLOUDFLARE_API_TOKEN: 'deploy-token',
			CLOUDFLARE_APP_API_TOKEN: 'application-token',
		}),
	).toEqual({
		...turnstileKeys,
		COOKIE_SECRET: 'cookie',
		SECRET_STORE_KEY: 'store',
		CLOUDFLARE_API_TOKEN: 'application-token',
	})
})
test('refuses resource drift or extra bindings between review and deployment', () => {
	const production = {
		vars: { APP_BASE_URL: 'https://kody.codes' },
		d1_databases: [{ binding: 'APP_DB', database_id: 'live-id' }],
		services: [
			{ binding: 'JOBS', service: 'kody-jobs', entrypoint: 'JobsService' },
		],
		queues: { producers: [{ binding: 'QUEUE', queue: 'live-queue' }] },
	}
	expect(() =>
		assertSharedBindings(structuredClone(production), production),
	).not.toThrow()
	const changed = structuredClone(production)
	changed.d1_databases[0]!.database_id = 'different-id'
	expect(() => assertSharedBindings(changed, production)).toThrow(
		'Shared d1_databases',
	)
	const added = structuredClone(production)
	added.services.push({
		binding: 'EXTRA',
		service: 'another-worker',
		entrypoint: 'JobsService',
	})
	expect(() => assertSharedBindings(added, production)).toThrow(
		'Shared services',
	)
	const queueChanged = structuredClone(production)
	queueChanged.queues.producers[0]!.queue = 'other-queue'
	expect(() => assertSharedBindings(queueChanged, production)).toThrow(
		'Shared queues',
	)
})

test.each([
	{
		field: 'artifacts',
		value: [{ binding: 'ARTIFACTS', namespace: 'changed' }],
	},
	{
		field: 'vars',
		value: { APP_BASE_URL: 'https://kody.codes', FEATURE: 'changed' },
	},
	{ field: 'compatibility_date', value: '2026-10-15' },
	{ field: 'compatibility_flags', value: ['nodejs_compat', 'new_flag'] },
	{ field: 'ai', value: { binding: 'DIFFERENT_AI' } },
	{ field: 'images', value: { binding: 'DIFFERENT_IMAGES' } },
	{ field: 'version_metadata', value: { binding: 'DIFFERENT_VERSION' } },
	{ field: 'worker_loaders', value: [{ binding: 'DIFFERENT_LOADER' }] },
	{
		field: 'send_email',
		value: [{ name: 'EMAIL', destination_address: 'changed@example.com' }],
	},
	{
		field: 'ratelimits',
		value: [
			{ name: 'AUTH', namespace_id: '1', simple: { limit: 999, period: 60 } },
		],
	},
	{ field: 'futureCopiedField', value: { enabled: false } },
])('rejects complete snapshot drift in $field', ({ field, value }) => {
	const snapshot = {
		vars: { APP_BASE_URL: 'https://kody.codes', FEATURE: 'original' },
		artifacts: [{ binding: 'ARTIFACTS', namespace: 'production' }],
		compatibility_date: '2026-04-16',
		compatibility_flags: ['nodejs_compat'],
		ai: { binding: 'AI' },
		images: { binding: 'IMAGES' },
		version_metadata: { binding: 'CF_VERSION_METADATA' },
		worker_loaders: [{ binding: 'LOADER' }],
		send_email: [{ name: 'EMAIL' }],
		ratelimits: [
			{ name: 'AUTH', namespace_id: '1', simple: { limit: 10, period: 60 } },
		],
		futureCopiedField: { enabled: true },
	}
	expect(() =>
		assertProductionSnapshot(
			snapshot,
			{ ...snapshot, [field]: value },
			['COOKIE_SECRET'],
			['COOKIE_SECRET'],
		),
	).toThrow('Production configuration changed')
	// Build verification also compares every copied field, including future ones.
	expect(() =>
		assertSharedBindings({ ...snapshot, [field]: value }, snapshot),
	).toThrow(`Shared ${field}`)
})

test('normalizes object and binding order while preserving all values and secret names', () => {
	const snapshot = {
		vars: { B: 'b', A: 'a' },
		services: [
			{ binding: 'B', service: 'two' },
			{ binding: 'A', service: 'one' },
		],
	}
	const reordered = {
		services: [
			{ service: 'one', binding: 'A' },
			{ service: 'two', binding: 'B' },
		],
		vars: { A: 'a', B: 'b' },
	}
	expect(() =>
		assertProductionSnapshot(
			snapshot,
			reordered,
			['COOKIE_SECRET', 'SECRET_STORE_KEY'],
			['SECRET_STORE_KEY', 'COOKIE_SECRET'],
		),
	).not.toThrow()
	expect(() =>
		assertProductionSnapshot(
			snapshot,
			reordered,
			['COOKIE_SECRET'],
			['COOKIE_SECRET', 'NEW_SECRET'],
		),
	).toThrow('Production secret names changed')
	expect(() =>
		assertProductionSnapshot(
			snapshot,
			reordered,
			['COOKIE_SECRET', 'SECRET_STORE_KEY'],
			['COOKIE_SECRET'],
		),
	).toThrow('Production secret names changed')
})

test('preserves JSON variable array order during complete snapshot comparison', () => {
	const snapshot = { vars: { ORDERED_STEPS: ['read', 'write'] } }
	const changed = { vars: { ORDERED_STEPS: ['write', 'read'] } }
	expect(() => assertProductionSnapshot(snapshot, changed, [], [])).toThrow(
		'Production configuration changed',
	)
})

test('keeps audited legacy DR credentials out of the website candidate even when available', () => {
	const names = [
		'DR_BACKUP_ACCESS_KEY_ID',
		'DR_BACKUP_SECRET_ACCESS_KEY',
		'DR_BACKUP_ACCOUNT_ID',
		'DR_BACKUP_BUCKET_NAME',
		'DR_RESTORE_SECRET',
	]
	const environment = {
		...turnstileKeys,
		COOKIE_SECRET: 'cookie',
		SECRET_STORE_KEY: 'store',
		DR_BACKUP_ACCESS_KEY_ID: 's3-access',
		DR_BACKUP_SECRET_ACCESS_KEY: 's3-secret',
		DR_BACKUP_ACCOUNT_ID: 'backup-account',
		DR_BACKUP_BUCKET_NAME: 'backup-bucket',
		DR_RESTORE_SECRET: 'restore-secret',
		DR_DEPLOY_TOKEN: 'must-not-copy-provisioner',
	}
	expect(collectCandidateSecrets(names, environment)).toEqual({
		...turnstileKeys,
		COOKIE_SECRET: 'cookie',
		SECRET_STORE_KEY: 'store',
	})
	expect(
		collectCandidateSecrets(names, {
			...turnstileKeys,
			COOKIE_SECRET: 'cookie',
			SECRET_STORE_KEY: 'store',
		}),
	).toEqual({
		...turnstileKeys,
		COOKIE_SECRET: 'cookie',
		SECRET_STORE_KEY: 'store',
	})
	expect(() =>
		collectCandidateSecrets([...names, 'DR_DEPLOY_TOKEN'], environment),
	).toThrow('Missing reviewed secret mappings: DR_DEPLOY_TOKEN')
})

test('reports every unmapped and unavailable name together without exposing any values', () => {
	const environment = {
		...turnstileKeys,
		COOKIE_SECRET: 'private-cookie-value',
		SECRET_STORE_KEY: 'private-store-value',
		STRIPE_SECRET_KEY: '',
		SENTRY_DSN: '',
		PACKAGE_APP_TICKET_KEYS: '',
		UNKNOWN_ONE: 'private-unknown-value',
	}
	try {
		collectCandidateSecrets(
			[
				'UNKNOWN_TWO',
				'STRIPE_SECRET_KEY',
				'SENTRY_DSN',
				'PACKAGE_APP_TICKET_KEYS',
				'UNKNOWN_ONE',
				'STRIPE_SECRET_KEY',
			],
			environment,
		)
	} catch (error) {
		const message = String(error)
		expect(message).toContain(
			'Missing reviewed secret mappings: UNKNOWN_ONE, UNKNOWN_TWO',
		)
		expect(message).toContain(
			'Trusted production secrets unavailable: PACKAGE_APP_TICKET_KEYS, SENTRY_DSN, STRIPE_SECRET_KEY',
		)
		expect(message).not.toContain('private-cookie-value')
		expect(message).not.toContain('private-store-value')
		expect(message).not.toContain('private-unknown-value')
		return
	}
	throw new Error(
		'Expected incomplete trusted production secret sources to fail closed',
	)
})

test('protocol-only exclusion cannot remove mandatory website session or encryption secrets', () => {
	expect(() => collectCandidateSecrets(['DR_RESTORE_SECRET'], {})).toThrow(
		'Trusted production secrets unavailable: COOKIE_SECRET, SECRET_STORE_KEY',
	)
	expect(() =>
		collectCandidateSecrets(
			['DR_BACKUP_SECRET_ACCESS_KEY', 'STRIPE_SECRET_KEY'],
			{ ...turnstileKeys, COOKIE_SECRET: 'cookie', SECRET_STORE_KEY: 'store' },
		),
	).toThrow('Trusted production secrets unavailable: STRIPE_SECRET_KEY')
})

test('preserves the existing Turnstile key pair required by native website auth forms', () => {
	const environment = {
		...turnstileKeys,
		COOKIE_SECRET: 'cookie',
		SECRET_STORE_KEY: 'store',
		TURNSTILE_SITE_KEY: 'production-site-key',
		TURNSTILE_SECRET_KEY: 'production-secret-key',
	}
	expect(
		collectCandidateSecrets(
			['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'],
			environment,
		),
	).toEqual(environment)
	expect(() =>
		collectCandidateSecrets(['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'], {
			COOKIE_SECRET: 'cookie',
			SECRET_STORE_KEY: 'store',
		}),
	).toThrow(
		'Trusted production secrets unavailable: TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY',
	)
})

test('Vite owns the exact bundling controls transformed in the retained rollout artifact', () => {
	const source = {
		vars: { APP_BASE_URL: 'https://kody.codes' },
		compatibility_date: '2026-04-16',
		compatibility_flags: ['nodejs_compat'],
		minify: true,
		find_additional_modules: true,
		rules: [{ type: 'Text', globs: ['./docs/*.md'] }],
		d1_databases: [{ binding: 'APP_DB', database_id: 'existing-db' }],
		services: [
			{ binding: 'JOBS', service: 'kody-jobs', entrypoint: 'JobsService' },
		],
		limits: { cpu_ms: 30000 },
		observability: { enabled: true },
	}
	const built: Record<string, unknown> = structuredClone(source)
	delete built.minify
	delete built.find_additional_modules
	built.no_bundle = true
	built.rules = [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }]
	expect(() => assertSharedBindings(built, source)).not.toThrow()
	expect(() =>
		assertSharedBindings({ ...built, limits: { cpu_ms: 1000 } }, source),
	).toThrow('Shared limits')
	expect(() =>
		assertSharedBindings(
			{ ...built, observability: { enabled: false } },
			source,
		),
	).toThrow('Shared observability')
	expect(() =>
		assertSharedBindings({ ...built, compatibility_flags: [] }, source),
	).toThrow('Shared compatibility_flags')
	expect(() =>
		assertSharedBindings(
			{
				...built,
				d1_databases: [{ binding: 'APP_DB', database_id: 'different-db' }],
			},
			source,
		),
	).toThrow('Shared d1_databases')
})

test('deploys router source from its config directory and preserves bundled candidate cwd', () => {
	const root = '/workspace/kody'
	const router = inactiveDeployInvocation(
		'packages/start-routing-worker/wrangler-start.generated.json',
		`kody-start-router-${'a'.repeat(40)}`,
		'/tmp/private/secrets.json',
		root,
	)
	expect(router.cwd).toBe('/workspace/kody/packages/start-routing-worker')
	expect(router.args).toEqual([
		'deploy',
		'--config',
		'wrangler-start.generated.json',
		'--name',
		`kody-start-router-${'a'.repeat(40)}`,
		'--secrets-file',
		'/tmp/private/secrets.json',
	])
	const candidate = inactiveDeployInvocation(
		'dist/server/wrangler.json',
		'kody-start-release',
		'/tmp/private/secrets.json',
		root,
	)
	expect(candidate.cwd).toBe(root)
	expect(candidate.args[2]).toBe('dist/server/wrangler.json')
})

test('preflights every text and secret binding using UTF8 bytes without revealing values', () => {
	expect(() =>
		assertBindingSizes({ vars: { OK: 'a'.repeat(5120) } }, {}),
	).not.toThrow()
	for (const [config, secrets, name] of [
		[{ vars: { LONG: 'a'.repeat(5121) } }, {}, 'LONG'],
		[{ vars: { UNICODE: 'é'.repeat(2561) } }, {}, 'UNICODE'],
		[{ vars: { JSON: { content: 'a'.repeat(5120) } } }, {}, 'JSON'],
		[{}, { SECRET: 'a'.repeat(5121) }, 'SECRET'],
	] as const) {
		expect(() => assertBindingSizes(config, secrets)).toThrow(name)
	}
})

test('release-specific router source keeps Wrangler config cwd resolution', () => {
	const name = `kody-start-router-${'a'.repeat(40)}`
	const invocation = inactiveDeployInvocation(
		'packages/start-routing-worker/wrangler-start.generated.json',
		name,
		'/tmp/secrets.json',
		'/workspace/kody',
	)
	expect(invocation.cwd).toBe('/workspace/kody/packages/start-routing-worker')
	expect(invocation.args[2]).toBe('wrangler-start.generated.json')
})

test('production candidate refuses missing Turnstile keys even when absent from live inventory', () => {
	expect(() =>
		collectCandidateSecrets([], {
			COOKIE_SECRET: 'cookie',
			SECRET_STORE_KEY: 'store',
		}),
	).toThrow(
		'Trusted production secrets unavailable: TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY',
	)
	expect(
		collectCandidateSecrets([], {
			...turnstileKeys,
			COOKIE_SECRET: 'cookie',
			SECRET_STORE_KEY: 'store',
		}),
	).toEqual({
		...turnstileKeys,
		COOKIE_SECRET: 'cookie',
		SECRET_STORE_KEY: 'store',
	})
})

test('blank Turnstile provisioning is rejected before candidate creation', () => {
	expect(() =>
		collectCandidateSecrets([], {
			COOKIE_SECRET: 'cookie',
			SECRET_STORE_KEY: 'store',
			TURNSTILE_SITE_KEY: '  ',
			TURNSTILE_SECRET_KEY: '\t',
		}),
	).toThrow(
		'Trusted production secrets unavailable: TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY',
	)
})
