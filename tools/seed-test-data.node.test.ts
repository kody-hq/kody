import { expect, test, vi } from 'vitest'

import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	buildSeedFeatureFlagOverrideSql,
	buildSeedSavedPackagesSql,
	seedSavedPackageIds,
	seedStableUserIdFromEmail,
} from './seed-sql.ts'
import {
	buildSeedSql,
	shouldSeedCompanionAccount,
	parseArgs,
	resolveWranglerEnv,
} from './seed-test-data.ts'

function mockProcessExit() {
	const spy = vi.spyOn(process, 'exit').mockImplementation((() => {
		throw new Error('process.exit called')
	}) as never)
	return { [Symbol.dispose]: () => spy.mockRestore() }
}

test('seed data arg parsing defaults to local mode and derives usernames from email unless overridden', () => {
	const defaultOptions = parseArgs(['--email', 'alice.dev+preview@example.com'])
	expect(defaultOptions.local).toBe(true)
	expect(defaultOptions.remote).toBe(false)
	expect(defaultOptions.email).toBe('alice.dev+preview@example.com')
	expect(defaultOptions.username).toBe('alice-dev-preview')
	expect(defaultOptions.env).toBe('production')

	const explicitUsernameOptions = parseArgs([
		'--email',
		'alice@example.com',
		'--username',
		'alice',
		'--local',
	])
	expect(explicitUsernameOptions.email).toBe('alice@example.com')
	expect(explicitUsernameOptions.username).toBe('alice')

	const adminOptions = parseArgs(['--local', '--admin'])
	expect(adminOptions.admin).toBe(true)

	expect(
		resolveWranglerEnv({
			config: 'packages/worker/wrangler-preview.generated.json',
		}),
	).toBe('preview')
})

test('seed data grants admin to the default fixture account only', () => {
	// Default account (kody@example.com) is admin so RBAC is testable.
	const defaultOptions = parseArgs(['--local'])
	expect(defaultOptions.email).toBe('kody@example.com')
	expect(defaultOptions.admin).toBe(true)

	// Custom accounts stay non-admin unless requested.
	const customOptions = parseArgs(['--local', '--email', 'me@example.com'])
	expect(customOptions.admin).toBe(false)

	const customAdminOptions = parseArgs([
		'--local',
		'--email',
		'me@example.com',
		'--admin',
	])
	expect(customAdminOptions.admin).toBe(true)

	// --no-admin opts the default account out.
	const optOutOptions = parseArgs(['--local', '--no-admin'])
	expect(optOutOptions.admin).toBe(false)
})

test('buildSeedSql seeds each account with its roles', () => {
	const sql = buildSeedSql([
		{
			email: 'kody@example.com',
			username: 'kody',
			passwordHash: 'hash-a',
			admin: true,
		},
		{
			email: 'jane@example.com',
			username: 'jane',
			passwordHash: 'hash-b',
			admin: false,
		},
	])

	expect(sql).toContain(`'kody@example.com'`)
	expect(sql).toContain(`'jane@example.com'`)
	// Both accounts get the user role; only the admin account gets admin.
	expect(sql.match(/r\.name = 'user'/g)).toHaveLength(2)
	expect(sql.match(/r\.name = 'admin'/g)).toHaveLength(1)
	expect(sql).toContain(
		`WHERE u.email = 'kody@example.com' AND r.name = 'admin'`,
	)
	expect(sql).toContain(`'google-work'`)
	expect(sql).toContain(
		`(SELECT stable_user_id FROM users WHERE email = 'kody@example.com')`,
	)
	expect(sql).toContain(seedStableUserIdFromEmail('kody@example.com'))
	expect(sql).toContain(seedStableUserIdFromEmail('jane@example.com'))
	expect(sql).toContain('INSERT INTO orgs')
	expect(sql).toContain('INSERT OR IGNORE INTO org_memberships')
	expect(sql).toContain('INSERT INTO handles')
})

test('seeded users keep a stored stable id and use a deterministic fixture id', () => {
	expect(seedStableUserIdFromEmail('Kody@Example.com ')).toBe(
		seedStableUserIdFromEmail('kody@example.com'),
	)
	expect(seedStableUserIdFromEmail('kody@example.com')).toMatch(
		/^[a-f0-9]{64}$/,
	)
	const sql = buildSeedSql([
		{
			email: 'kody@example.com',
			username: 'kody',
			passwordHash: 'hash-a',
			admin: true,
		},
	])
	expect(sql).toContain(seedStableUserIdFromEmail('kody@example.com'))
	expect(sql).toContain(
		'stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id)',
	)
})

test('companion fixture account is local-only', () => {
	expect(
		shouldSeedCompanionAccount({ local: true, email: 'kody@example.com' }),
	).toBe(true)
	// Never seed the fixed-password companion into remote environments.
	expect(
		shouldSeedCompanionAccount({ local: false, email: 'kody@example.com' }),
	).toBe(false)
	// Avoid duplicating the companion when it is the primary account.
	expect(
		shouldSeedCompanionAccount({ local: true, email: 'jane@example.com' }),
	).toBe(false)
})

test('local seed can add metadata-only packages and feature flag overrides', () => {
	const options = parseArgs([
		'--local',
		'--saved-packages',
		'3',
		'--enable-flag',
		'connection-profiles',
		'--enable-flag',
		'demo-indicator',
	])
	expect(options.savedPackages).toBe(3)
	expect(options.enableFlags).toEqual(['connection-profiles', 'demo-indicator'])

	const sql = buildSeedSql(
		[
			{
				email: 'jane@example.com',
				username: 'jane',
				passwordHash: 'hash',
				admin: false,
			},
		],
		{
			savedPackages: 3,
			enableFlags: ['connection-profiles'],
		},
	)
	const { packageId, sourceId } = seedSavedPackageIds({
		email: 'jane@example.com',
		index: 1,
	})
	expect(sql).toContain(`'${packageId}'`)
	expect(sql).toContain(`'${sourceId}'`)
	expect(sql).toContain(`'local-seed-pkg-1'`)
	expect(sql).toContain(`'local-seed-pkg-3'`)
	expect(sql).toContain(`flag_key`)
	expect(sql).toContain(`'connection-profiles'`)
	expect(sql).toContain(`WHERE u.email = 'jane@example.com'`)
	// Metadata-only: no artifact or entity_sources rows.
	expect(sql).not.toContain('entity_sources')
	expect(sql).not.toContain('published_bundle_artifacts')

	const packagesOnly = buildSeedSavedPackagesSql({
		email: 'jane@example.com',
		count: 2,
	})
	expect(packagesOnly.match(/INSERT INTO saved_packages/g)).toHaveLength(2)

	const flagSql = buildSeedFeatureFlagOverrideSql({
		email: 'jane@example.com',
		flagKey: 'connection-profiles',
	})
	expect(flagSql).toContain('feature_flag_user_overrides')
	expect(flagSql).toContain(`'connection-profiles'`)
})

test('remote enable-flag is preview-only and allowlisted', () => {
	const preview = parseArgs([
		'--remote',
		'--env',
		'preview',
		'--enable-flag',
		'connection-profiles',
		'--enable-flag',
		'demo-indicator',
	])
	expect(preview.env).toBe('preview')
	expect(preview.enableFlags).toEqual(['connection-profiles', 'demo-indicator'])

	const fromPreviewConfig = parseArgs([
		'--remote',
		'--config',
		'packages/worker/wrangler.preview.json',
		'--enable-flag',
		'connection-profiles',
	])
	expect(fromPreviewConfig.env).toBe('preview')
	expect(fromPreviewConfig.enableFlags).toEqual(['connection-profiles'])

	const reconciled = buildSeedSql(
		[
			{
				email: 'me@kentcdodds.com',
				username: 'user-me',
				passwordHash: 'hash',
				admin: false,
			},
		],
		{
			enableFlags: ['connection-profiles'],
			reconcilePreviewFlags: true,
		},
	)
	expect(reconciled).toContain('DELETE FROM feature_flag_user_overrides')
	expect(reconciled).toContain(`'demo-indicator'`)

	const localOnly = buildSeedSql(
		[
			{
				email: 'jane@example.com',
				username: 'jane',
				passwordHash: 'hash',
				admin: false,
			},
		],
		{ enableFlags: ['connection-profiles'] },
	)
	expect(localOnly).not.toContain('DELETE FROM feature_flag_user_overrides')
})

test('saved-packages and non-preview enable-flag are rejected for remote seed', () => {
	consoleError.mockImplementation(() => {})
	using _exit = mockProcessExit()

	expect(() => parseArgs(['--remote', '--saved-packages', '2'])).toThrow(
		'process.exit called',
	)
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('local-only'),
	)

	expect(() =>
		parseArgs([
			'--remote',
			'--env',
			'production',
			'--enable-flag',
			'connection-profiles',
		]),
	).toThrow('process.exit called')
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('only allowed when the wrangler env is preview'),
	)

	expect(() =>
		parseArgs([
			'--remote',
			'--env',
			'preview',
			'--enable-flag',
			'mcp-skills-extension',
		]),
	).toThrow('process.exit called')
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('not on the preview seed allowlist'),
	)

	const previousCloudflareEnv = process.env.CLOUDFLARE_ENV
	delete process.env.CLOUDFLARE_ENV
	try {
		expect(() =>
			parseArgs(['--remote', '--enable-flag', 'connection-profiles']),
		).toThrow('process.exit called')
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('only allowed when the wrangler env is preview'),
		)
	} finally {
		if (previousCloudflareEnv === undefined) {
			delete process.env.CLOUDFLARE_ENV
		} else {
			process.env.CLOUDFLARE_ENV = previousCloudflareEnv
		}
	}

	expect(() => parseArgs(['--local', '--enable-flag', 'not-a-flag'])).toThrow(
		'process.exit called',
	)
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('Unknown feature flag key'),
	)

	expect(() => parseArgs(['--local', '--saved-packages', '0'])).toThrow(
		'process.exit called',
	)
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('--saved-packages must be an integer'),
	)
})
