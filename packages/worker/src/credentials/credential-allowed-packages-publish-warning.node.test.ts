import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	buildCredentialAllowedPackagesPublishWarningNotice,
	buildCredentialAllowedPackagesPublishWarnings,
	collectLiteralUserSecretNames,
	credentialAllowedPackagesEnforcementDate,
	filesForPackageSourceRoot,
	formatAllowedPackagesList,
	formatCredentialAllowedPackagesPublishWarning,
	resolveAllowedPackagesListEntries,
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

test('formatAllowedPackagesList labels real packages and non-id entries', () => {
	expect(
		formatAllowedPackagesList([
			{ kind: 'package', id: 'pkg-notes', displayName: '@owner/notes' },
			{ kind: 'not-a-package-id', value: '@someone/pkg' },
		]),
	).toBe('@owner/notes, @someone/pkg (not a package id; fix the list)')
})

test('formatCredentialAllowedPackagesPublishWarning uses the Oct 21 enforcement wording', () => {
	const message = formatCredentialAllowedPackagesPublishWarning({
		credentialName: 'RESEND_API_KEY',
		allowedEntries: [
			{ kind: 'package', id: 'pkg-notes', displayName: '@owner/notes' },
		],
		packageDisplayName: '@owner/demo',
		approvalUrl:
			'https://kody.codes/@owner/-/secrets/user/RESEND_API_KEY?package_id=pkg-demo&package=demo',
	})
	expect(message).toContain('Credential "RESEND_API_KEY"')
	expect(message).toContain('allowed only for @owner/notes, not @owner/demo')
	expect(message).toContain(credentialAllowedPackagesEnforcementDate)
	expect(message).toContain(
		'through another package or loaded in a one-off execute',
	)
	expect(message).toContain(
		'https://kody.codes/@owner/-/secrets/user/RESEND_API_KEY?package_id=pkg-demo&package=demo',
	)
	expect(message).not.toMatch(/cipher|value|password/i)
})

test('resolveAllowedPackagesListEntries marks missing ids', () => {
	const packagesById = new Map([
		['pkg-notes', { id: 'pkg-notes', name: '@owner/notes', kodyId: 'notes' }],
	])
	expect(
		resolveAllowedPackagesListEntries({
			allowedPackages: ['pkg-notes', '@someone/pkg'],
			packagesById,
		}),
	).toEqual([
		{ kind: 'package', id: 'pkg-notes', displayName: '@owner/notes' },
		{ kind: 'not-a-package-id', value: '@someone/pkg' },
	])
})

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

test('filesForPackageSourceRoot scopes nested package paths like credential inventory', () => {
	const nested = filesForPackageSourceRoot(
		{
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
})

test('builder respects package source root and ignores sibling fills', async () => {
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
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	const repoFiles = {
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
	const scoped = await buildCredentialAllowedPackagesPublishWarnings({
		env,
		baseUrl,
		userId,
		packageId: 'pkg-demo',
		packageDisplayName: '@owner/demo',
		kodyId: 'demo',
		files: repoFiles,
		sourceRoot: 'packages/demo',
	})
	expect(scoped.map((warning) => warning.credentialName)).toEqual(['DEMO_KEY'])

	const unscoped = await buildCredentialAllowedPackagesPublishWarnings({
		env,
		baseUrl,
		userId,
		packageId: 'pkg-demo',
		packageDisplayName: '@owner/demo',
		kodyId: 'demo',
		files: repoFiles,
	})
	expect(unscoped.map((warning) => warning.credentialName).sort()).toEqual([
		'DEMO_KEY',
		'OTHER_KEY',
	])
})

test('publish-flow notice appears while the save/publish path stays non-blocking', async () => {
	const { env } = seedEnv({
		allowedPackages: ['pkg-notes'],
		packages: [
			{ id: 'pkg-demo', name: '@owner/demo', kodyId: 'demo' },
			{ id: 'pkg-notes', name: '@owner/notes', kodyId: 'notes' },
		],
	})
	const notice = await buildCredentialAllowedPackagesPublishWarningNotice({
		env,
		baseUrl,
		userId,
		packageId: 'pkg-demo',
		packageDisplayName: '@owner/demo',
		kodyId: 'demo',
		files: packageFiles('RESEND_API_KEY'),
	})
	expect(notice).toContain('Credential "RESEND_API_KEY"')
	expect(notice).toContain('@owner/notes')
	expect(notice).toContain('not @owner/demo')
	expect(notice).toContain(credentialAllowedPackagesEnforcementDate)
	expect(notice).toContain('package_id=pkg-demo')

	const { buildPackageSaveNextSteps } =
		await import('#mcp/capabilities/packages/save-package.ts')
	const nextSteps = buildPackageSaveNextSteps({
		packageId: 'pkg-demo',
		allowedPackagesPublishNotice: notice,
	})
	expect(nextSteps).toContain('packageGetGitRemote')
	expect(nextSteps).toContain('Credential "RESEND_API_KEY"')
	// The notice is appended; save/publish still return success with next_steps.
	expect(nextSteps.startsWith('Coding agents')).toBe(true)
})
