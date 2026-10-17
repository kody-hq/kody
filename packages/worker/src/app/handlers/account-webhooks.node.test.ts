import { loadAccountWebhooksData } from '#app/package-webhooks-data.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

const savedPackages = [
	{
		id: 'pkg-1',
		userId: ownerIdFromStored('set-per-test'),
		name: '@owner/sentry-bridge',
		kodyId: 'sentry-bridge',
		description: 'Sentry bridge',
		tags: [],
		searchText: null,
		sourceId: 'src-1',
		hasApp: false,
		hidden: false,
		isPrivate: true,
		isInternetVisible: false,
		createdAt: '2026-07-24T00:00:00.000Z',
		updatedAt: '2026-07-24T00:00:00.000Z',
	},
	{
		id: 'pkg-2',
		userId: ownerIdFromStored('set-per-test'),
		name: '@owner/raycast',
		kodyId: 'raycast',
		description: 'Raycast bridge',
		tags: [],
		searchText: null,
		sourceId: 'src-2',
		hasApp: false,
		hidden: false,
		isPrivate: true,
		isInternetVisible: false,
		createdAt: '2026-07-24T00:00:00.000Z',
		updatedAt: '2026-07-24T00:00:00.000Z',
	},
]

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: vi.fn(
		async (_db: unknown, input: { userId: string }) =>
			savedPackages.map((entry) => ({
				...entry,
				userId: ownerIdFromStored(input.userId),
			})),
	),
	resolveSavedPackageRef: vi.fn(),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: vi.fn(async (input: { sourceId: string }) => ({
		manifest:
			input.sourceId === 'src-1'
				? {
						name: '@owner/sentry-bridge',
						exports: { './handle-sentry-webhook': './src/sentry.ts' },
						kody: {
							id: 'sentry-bridge',
							webhooks: [{ name: 'sentry', export: './handle-sentry-webhook' }],
						},
					}
				: {
						name: '@owner/raycast',
						exports: {
							'./list-commands': './src/list-commands.ts',
							'./run': './src/run.ts',
						},
						kody: {
							id: 'raycast',
							webhooks: [
								{
									name: 'list-commands',
									export: './list-commands',
									responseMode: 'sync',
									inputMode: 'params',
								},
								{
									name: 'run',
									export: './run',
									responseMode: 'sync',
									inputMode: 'params',
								},
							],
						},
					},
	})),
}))

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE webhook_endpoints (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			webhook_name TEXT NOT NULL,
			url_secret_hash TEXT NOT NULL,
			url_secret_encrypted TEXT,
			hmac_secret_encrypted TEXT,
			previous_url_secret_hash TEXT,
			previous_url_secret_expires_at TEXT,
			enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
			deleted_at TEXT,
			instance_label TEXT,
			created_at TEXT NOT NULL,
			rotated_at TEXT NOT NULL
		);
	`)
	return {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
}

const owner = { email: 'owner@example.com', username: 'owner' }

test('webhook index data includes every package declaration without revealing URLs', async () => {
	const userId = testStableUserIdFromEmail(owner.email)
	const data = await loadAccountWebhooksData({
		env: createEnv(),
		requestUrl: 'https://kody.example/account/webhooks',
		user: {
			...owner,
			mcpUser: {
				userId: personIdFromStored(userId),
				email: owner.email,
				username: owner.username,
				displayName: owner.username,
			},
			request: sessionRequestContext(userId),
		},
	})
	expect(data.username).toBe('owner')
	expect(data.webhooks.map((webhook) => webhook.id)).toEqual([
		'raycast/list-commands',
		'raycast/run',
		'sentry-bridge/sentry',
	])
	expect(JSON.stringify(data)).not.toContain('"url"')
})

test('account webhooks API lists across packages and is read-only: mutations belong to the package API', async () => {
	const userId = testStableUserIdFromEmail(owner.email)
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		...owner,
		mcpUser: {
			userId: ownerIdFromStored(userId),
			email: owner.email,
			username: owner.username,
			displayName: owner.username,
		},
		request: sessionRequestContext(userId),
	})
	const body = await loadAccountWebhooksData({
		env: createEnv(),
		requestUrl: 'https://kody.example/account/webhooks',
		user: await mockModule.readAuthenticatedAppUser(),
	})
	expect(body.webhooks.map((webhook) => webhook.packageKodyId)).toEqual([
		'raycast',
		'raycast',
		'sentry-bridge',
	])
	expect(body.webhooks.every((webhook) => !webhook.minted)).toBe(true)
})
