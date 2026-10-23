import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	buildCredentialAllowedPackagesPublishWarningNotice,
	buildCredentialAllowedPackagesPublishWarnings,
	collectLiteralUserSecretNames,
	filesForPackageSourceRoot,
} from './credential-allowed-packages-publish-warning.ts'
import { scanPackageCredentials } from './credential-inventory-scan.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const userId = ownerIdFromStored('org-owner')
const baseUrl = 'https://kody.codes'

function packageFiles(credentialName: string) {
	return {
		'package.json': JSON.stringify({
			name: '@owner/demo',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'demo',
				description: 'Demo package.',
				credentials: {
					[credentialName]: {
						kind: 'secret',
						provider: 'resend',
						description: 'API key for outbound mail.',
					},
				},
			},
		}),
		'src/index.ts': `export const h = { Authorization: 'Bearer {{secret:${credentialName}}}' }\n`,
	}
}

function seedEnv(input: {
	allowedPackages: Array<string>
	packages: Array<{ id: string; name: string; kodyId: string }>
	secretName?: string
}) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const now = '2026-10-18T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, 'owner', 'pro', ?, ?)`,
		)
		.run(userId, now, now)
	for (const saved of input.packages) {
		sqlite
			.prepare(
				`INSERT INTO saved_packages (
					id, user_id, name, kody_id, description, source_id, created_at, updated_at
				) VALUES (?, ?, ?, ?, '', ?, ?, ?)`,
			)
			.run(
				saved.id,
				userId,
				saved.name,
				saved.kodyId,
				`source-${saved.id}`,
				now,
				now,
			)
	}
	sqlite
		.prepare(
			`INSERT INTO secret_buckets (id, user_id, scope, binding_key, created_at, updated_at)
			 VALUES ('bucket-user', ?, 'user', '', ?, ?)`,
		)
		.run(userId, now, now)
	sqlite
		.prepare(
			`INSERT INTO secret_entries (
				id, bucket_id, name, encrypted_value, allowed_packages, created_at, updated_at
			) VALUES ('secret-1', 'bucket-user', ?, 'cipher', ?, ?, ?)`,
		)
		.run(
			input.secretName ?? 'RESEND_API_KEY',
			JSON.stringify(input.allowedPackages),
			now,
			now,
		)
	return {
		env: {
			APP_DB: createD1FromSqlite(sqlite),
			SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		} as Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>,
		sqlite,
	}
}

test('collectLiteralUserSecretNames skips package/session scopes and integrations', () => {
	const scan = scanPackageCredentials({
		files: {
			'index.ts': `
				const a = '{{secret:USER_KEY}}'
				const b = '{{secret:PKG_KEY|scope=package}}'
				const c = '{{integration-token:oauthToken}}'
			`,
		},
		slots: {
			SLOT_KEY: {
				kind: 'secret',
				provider: 'resend',
				description: 'Slot key.',
			},
			OAUTH: {
				kind: 'oauth',
				provider: 'github',
				description: 'OAuth.',
			},
		},
	})
	expect(collectLiteralUserSecretNames(scan)).toEqual(['SLOT_KEY', 'USER_KEY'])
})

test('builder warns when the package is not on a non-empty allowed list', async () => {
	const { env } = seedEnv({
		allowedPackages: ['pkg-notes', '@someone/pkg'],
		packages: [
			{ id: 'pkg-demo', name: '@owner/demo', kodyId: 'demo' },
			{ id: 'pkg-notes', name: '@owner/notes', kodyId: 'notes' },
		],
	})
	const warnings = await buildCredentialAllowedPackagesPublishWarnings({
		env,
		baseUrl,
		userId,
		packageId: 'pkg-demo',
		packageDisplayName: '@owner/demo',
		kodyId: 'demo',
		files: packageFiles('RESEND_API_KEY'),
	})
	expect(warnings).toHaveLength(1)
	expect(warnings[0]?.credentialName).toBe('RESEND_API_KEY')
	// allowed_packages are stored sorted (localeCompare), so @someone/pkg is first.
	expect(warnings[0]?.allowedEntries).toEqual([
		{ kind: 'not-a-package-id', value: '@someone/pkg' },
		{ kind: 'package', id: 'pkg-notes', displayName: '@owner/notes' },
	])
	expect(warnings[0]?.approvalUrl).toBe(
		'https://kody.codes/@owner/-/secrets/user/RESEND_API_KEY?package_id=pkg-demo&package=demo',
	)
})

test('builder stays quiet when the list is empty or already includes the package', async () => {
	const empty = seedEnv({
		allowedPackages: [],
		packages: [{ id: 'pkg-demo', name: '@owner/demo', kodyId: 'demo' }],
	})
	await expect(
		buildCredentialAllowedPackagesPublishWarningNotice({
			env: empty.env,
			baseUrl,
			userId,
			packageId: 'pkg-demo',
			packageDisplayName: '@owner/demo',
			kodyId: 'demo',
			files: packageFiles('RESEND_API_KEY'),
		}),
	).resolves.toBeNull()

	const allowed = seedEnv({
		allowedPackages: ['pkg-demo'],
		packages: [{ id: 'pkg-demo', name: '@owner/demo', kodyId: 'demo' }],
	})
	await expect(
		buildCredentialAllowedPackagesPublishWarningNotice({
			env: allowed.env,
			baseUrl,
			userId,
			packageId: 'pkg-demo',
			packageDisplayName: '@owner/demo',
			kodyId: 'demo',
			files: packageFiles('RESEND_API_KEY'),
		}),
	).resolves.toBeNull()
})

test('filesForPackageSourceRoot strips strictly with no fallback', () => {
	const nested = filesForPackageSourceRoot(
		{
			'package.json': '{"name":"workspace"}',
			'packages/demo/package.json': '{"name":"@owner/demo"}',
			'packages/demo/src/index.ts': "export const x = '{{secret:DEMO_KEY}}'\n",
			'packages/other/src/index.ts':
				"export const y = '{{secret:OTHER_KEY}}'\n",
			'README.md': '# root\n',
		},
		'packages/demo',
	)
	expect(nested).toEqual({
		'package.json': '{"name":"@owner/demo"}',
		'src/index.ts': "export const x = '{{secret:DEMO_KEY}}'\n",
	})
	expect(filesForPackageSourceRoot({ 'package.json': '{}' }, '/')).toEqual({
		'package.json': '{}',
	})
	expect(filesForPackageSourceRoot({ 'package.json': '{}' }, '.')).toEqual({
		'package.json': '{}',
	})
	expect(
		filesForPackageSourceRoot(
			{
				'packages/demo/package.json': '{"name":"@owner/demo"}',
				'packages/demo/src/index.ts': "export const x = '1'\n",
			},
			'./packages/demo',
		),
	).toEqual({
		'package.json': '{"name":"@owner/demo"}',
		'src/index.ts': "export const x = '1'\n",
	})
	// Already package-relative trees must omit sourceRoot at the call site.
	// Passing a nested root against that map strictly yields {}.
	expect(
		filesForPackageSourceRoot(
			{
				'package.json': '{"name":"@owner/demo"}',
				'src/index.ts': "export const x = '{{secret:DEMO_KEY}}'\n",
			},
			'packages/demo',
		),
	).toEqual({})
	expect(
		filesForPackageSourceRoot(
			{
				'package.json': '{"name":"workspace"}',
				'packages/other/src/index.ts':
					"export const y = '{{secret:OTHER_KEY}}'\n",
			},
			'packages/demo',
		),
	).toEqual({})
})

function seedDualSecretEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	const now = '2026-10-18T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, 'owner', 'pro', ?, ?)`,
		)
		.run(userId, now, now)
	for (const saved of [
		{ id: 'pkg-demo', name: '@owner/demo', kodyId: 'demo' },
		{ id: 'pkg-notes', name: '@owner/notes', kodyId: 'notes' },
	]) {
		sqlite
			.prepare(
				`INSERT INTO saved_packages (
					id, user_id, name, kody_id, description, source_id, created_at, updated_at
				) VALUES (?, ?, ?, ?, '', ?, ?, ?)`,
			)
			.run(
				saved.id,
				userId,
				saved.name,
				saved.kodyId,
				`source-${saved.id}`,
				now,
				now,
			)
	}
	sqlite
		.prepare(
			`INSERT INTO secret_buckets (id, user_id, scope, binding_key, created_at, updated_at)
			 VALUES ('bucket-user', ?, 'user', '', ?, ?)`,
		)
		.run(userId, now, now)
	for (const [id, name] of [
		['secret-demo', 'DEMO_KEY'],
		['secret-other', 'OTHER_KEY'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO secret_entries (
					id, bucket_id, name, encrypted_value, allowed_packages, created_at, updated_at
				) VALUES (?, 'bucket-user', ?, 'cipher', ?, ?, ?)`,
			)
			.run(id, name, JSON.stringify(['pkg-notes']), now, now)
	}
	return {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
}

test('builder ignores siblings in monorepo trees that include a root package.json', async () => {
	const env = seedDualSecretEnv()
	const monorepo = {
		'package.json': JSON.stringify({ name: 'workspace', private: true }),
		'packages/demo/package.json': JSON.stringify({
			name: '@owner/demo',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'demo',
				description: 'Demo package.',
				credentials: {
					DEMO_KEY: {
						kind: 'secret',
						provider: 'resend',
						description: 'Demo key.',
					},
				},
			},
		}),
		'packages/demo/src/index.ts':
			"export const h = { Authorization: 'Bearer {{secret:DEMO_KEY}}' }\n",
		'packages/other/src/index.ts': "export const y = '{{secret:OTHER_KEY}}'\n",
	}
	const warnings = await buildCredentialAllowedPackagesPublishWarnings({
		env,
		baseUrl,
		userId,
		packageId: 'pkg-demo',
		packageDisplayName: '@owner/demo',
		kodyId: 'demo',
		files: monorepo,
		sourceRoot: 'packages/demo',
	})
	expect(warnings.map((warning) => warning.credentialName)).toEqual([
		'DEMO_KEY',
	])
})
