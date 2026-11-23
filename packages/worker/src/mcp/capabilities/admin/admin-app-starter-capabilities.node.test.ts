import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { AppStarterError } from '#worker/app-starters/service.ts'
import type * as SentryModule from '@sentry/cloudflare'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { adminAppStarterAddCapability } from './admin-app-starter-add.ts'
import { adminAppStarterRemoveCapability } from './admin-app-starter-remove.ts'
import { adminAppStarterUpdateCapability } from './admin-app-starter-update.ts'

const sentry = vi.hoisted(() => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}))

vi.mock('@sentry/cloudflare', async (importOriginal) => ({
	...(await importOriginal<typeof SentryModule>()),
	isInitialized: () => true,
	getClient: () => ({ getOptions: () => ({ dsn: 'https://sentry.test/1' }) }),
	withScope: (callback: (scope: unknown) => void) =>
		callback({ setLevel() {}, setUser() {}, setTag() {}, setContext() {} }),
	captureException: sentry.captureException,
	captureMessage: sentry.captureMessage,
}))

function createStarterContext() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	sqlite.exec(`
		INSERT INTO orgs (id, slug, created_at, updated_at)
		VALUES ('org-kody', 'kody', '2026-11-22', '2026-11-22');
		INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
		VALUES
			('pkg-habit', 'org-kody', '@kody/example-habit-log', 'example-habit-log', '', 'source-habit'),
			('pkg-draft', 'org-kody', '@kody/draft', 'draft', '', 'source-draft');
		INSERT INTO app_starters (package_id, rank, enabled, note)
		VALUES ('pkg-habit', 1, 1, NULL);
	`)
	return {
		env: { APP_DB: createD1FromSqlite(sqlite) } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored('admin-user'),
				email: 'admin@example.com',
				displayName: 'admin',
				roles: ['admin'],
			},
		}),
	}
}

async function captureFailure(run: () => Promise<unknown>) {
	vi.spyOn(console, 'info').mockImplementation(() => {})
	const sourceReadError = vi
		.spyOn(console, 'error')
		.mockImplementation(() => {})
	const error = await run().then(
		() => {
			throw new Error('Expected the capability to fail.')
		},
		(caught: unknown) => caught,
	)
	return { error, sourceReadError }
}

test('adding an existing starter returns a 409 caller error and skips Sentry', async () => {
	const ctx = createStarterContext()
	const { error } = await captureFailure(() =>
		adminAppStarterAddCapability.handler(
			{ package: '@kody/example-habit-log' },
			ctx,
		),
	)
	expect(error).toBeInstanceOf(AppStarterError)
	expect(error).toBeInstanceOf(McpCallerError)
	expect(error).toMatchObject({
		status: 409,
		message:
			'@kody/example-habit-log is already a starter. To change its rank, note, or enabled state, update the existing starter (package id pkg-habit) instead of adding it again.',
	})
	expect(sentry.captureException).not.toHaveBeenCalled()
	expect(sentry.captureMessage).not.toHaveBeenCalled()
})

test('other starter refusals reach the caller with their message and skip Sentry', async () => {
	const ctx = createStarterContext()
	const cases = [
		{
			run: () =>
				adminAppStarterAddCapability.handler({ package: '@other/app' }, ctx),
			status: 400,
			message: 'Starters are packages in the @kody org. Enter @kody/app.',
		},
		{
			run: () =>
				adminAppStarterAddCapability.handler({ package: '@kody/missing' }, ctx),
			status: 404,
			message: '@kody/missing was not found.',
		},
		{
			run: () =>
				adminAppStarterAddCapability.handler({ package: '@kody/draft' }, ctx),
			status: 400,
			message: expect.stringMatching(
				/^@kody\/draft is not a valid starter\. Fix these fields:\n.*kody\.starter/,
			),
		},
		{
			run: () =>
				adminAppStarterUpdateCapability.handler(
					{ package_id: 'pkg-draft', enabled: false },
					ctx,
				),
			status: 404,
			message: 'That starter is not on the list.',
		},
		{
			run: () =>
				adminAppStarterRemoveCapability.handler(
					{ package_id: 'pkg-draft' },
					ctx,
				),
			status: 404,
			message: 'That starter is not on the list.',
		},
	]
	for (const { run, status, message } of cases) {
		const { error } = await captureFailure(run)
		expect(error).toBeInstanceOf(McpCallerError)
		expect(error).toMatchObject({ status, message })
	}
	const invalid = await captureFailure(() =>
		adminAppStarterAddCapability.handler({ package: '@kody/draft' }, ctx),
	)
	expect(invalid.error).toMatchObject({
		fieldErrors: expect.arrayContaining([
			expect.objectContaining({ field: expect.any(String) }),
		]),
	})
	expect(invalid.sourceReadError).toHaveBeenCalledWith(
		'app-starter-source-read-failed',
		expect.objectContaining({ packageId: 'pkg-draft' }),
	)
	expect(sentry.captureException).not.toHaveBeenCalled()
	expect(sentry.captureMessage).not.toHaveBeenCalled()
})
