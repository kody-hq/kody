import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	listActiveUserMcpOauthClientIds,
	listUserMcpOauthClients,
	maxUserMcpOauthClients,
	mintUserMcpOauthClient,
	parseClientLabel,
	parseRedirectUriText,
	revokeUserMcpOauthClient,
} from './account-mcp-oauth-clients.ts'

function createMigratedDb({ seedUser = true } = {}) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	if (seedUser) {
		sqlite.exec(`
			INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
			VALUES (1, 'one', 'one@example.com', 'user-one', 'hash', CURRENT_TIMESTAMP);
		`)
	}
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

type MintInput = Parameters<typeof mintUserMcpOauthClient>[0]
const callback = 'https://example.com/callback'

/** Provider helpers that mint `oauth-client-1`, `oauth-client-2`, ... */
function providerHelpers(
	deleteClient: MintInput['helpers']['deleteClient'] = vi.fn(
		async () => undefined,
	),
) {
	let created = 0
	return {
		createClient: vi.fn(async () => ({
			clientId: `oauth-client-${++created}`,
			clientSecret: 'secret',
		})),
		deleteClient,
	}
}

async function mintClients(
	db: D1Database,
	count: number,
	helpers = providerHelpers(),
) {
	for (let index = 0; index < count; index += 1) {
		const minted = await mintUserMcpOauthClient({
			db,
			helpers,
			userId: 1,
			label: `Client ${index + 1}`,
			redirectUris: [callback],
		})
		expect(minted.ok).toBe(true)
	}
}

test('parseClientLabel and parseRedirectUriText reject empty and unsafe values', () => {
	expect(parseClientLabel('')).toMatchObject({ ok: false })
	expect(parseClientLabel('  Open WebUI  ')).toEqual({
		ok: true,
		label: 'Open WebUI',
	})
	expect(parseRedirectUriText('')).toMatchObject({ ok: false })
	expect(parseRedirectUriText('javascript:alert(1)')).toMatchObject({
		ok: false,
	})
	expect(
		parseRedirectUriText(
			'https://openwebui.example/oauth/clients/mcp:kody/callback#x',
		),
	).toMatchObject({ ok: false })
	expect(
		parseRedirectUriText(
			'http://100.64.0.2:8080/oauth/clients/mcp:kody/callback\nhttps://openwebui.example/oauth/clients/mcp:kody/callback\nhttp://100.64.0.2:8080/oauth/clients/mcp:kody/callback',
		),
	).toEqual({
		ok: true,
		uris: [
			'http://100.64.0.2:8080/oauth/clients/mcp:kody/callback',
			'https://openwebui.example/oauth/clients/mcp:kody/callback',
		],
	})
})

test('mint stores ownership without the secret and revoke deletes the provider client', async () => {
	const { sqlite, db } = createMigratedDb()
	const helpers = {
		createClient: vi.fn(async () => ({
			clientId: 'oauth-client-1',
			clientSecret: 'plain-secret-once',
		})),
		deleteClient: vi.fn(async () => undefined),
	}
	const redirectUri = 'http://100.64.0.2:8080/oauth/clients/mcp:kody/callback'

	const minted = await mintUserMcpOauthClient({
		db,
		helpers,
		userId: 1,
		label: 'Open WebUI',
		redirectUris: [redirectUri],
	})
	if (!minted.ok) throw new Error('expected mint to succeed')
	expect(minted.client.clientSecret).toBe('plain-secret-once')
	expect(await listActiveUserMcpOauthClientIds(db, 1)).toEqual([
		'oauth-client-1',
	])

	const listed = await listUserMcpOauthClients(db, 1)
	expect(listed).toEqual([
		{
			id: minted.client.id,
			label: 'Open WebUI',
			clientId: 'oauth-client-1',
			redirectUris: [redirectUri],
			createdAt: minted.client.createdAt,
			revokedAt: null,
		},
	])
	expect(JSON.stringify(listed)).not.toContain('plain-secret-once')

	const insertSubscription = sqlite.prepare(
		`INSERT INTO mcp_event_subscriptions (
			id, user_id, oauth_client_id, event_name, arguments_json,
			callback_url, secret_encrypted
		) VALUES (?, 'user-one', ?, 'demo.ping', '{}', 'https://hooks.example.com/kody', 'x')`,
	)
	insertSubscription.run('sub_revoked_client', 'oauth-client-1')
	insertSubscription.run('sub_other_client', 'oauth-client-2')

	expect(
		await revokeUserMcpOauthClient({
			db,
			helpers,
			userId: 1,
			id: minted.client.id,
		}),
	).toEqual({ ok: true })
	expect(helpers.deleteClient).toHaveBeenCalledWith('oauth-client-1')
	expect(await listActiveUserMcpOauthClientIds(db, 1)).toEqual([])
	expect((await listUserMcpOauthClients(db, 1))[0]?.revokedAt).toBeTruthy()
	// The registration is gone, so its MCP event subscriptions go with it.
	expect(
		sqlite
			.prepare(`SELECT id FROM mcp_event_subscriptions ORDER BY id`)
			.all()
			.map((row) => row['id']),
	).toEqual(['sub_other_client'])
})

test('mint rolls back the provider client when D1 insert fails', async () => {
	const { db } = createMigratedDb({ seedUser: false })
	const helpers = providerHelpers()

	await expect(
		mintUserMcpOauthClient({
			db,
			helpers,
			userId: 99,
			label: 'Broken',
			redirectUris: [callback],
		}),
	).rejects.toThrow(/FOREIGN KEY|constraint/i)
	expect(helpers.deleteClient).toHaveBeenCalledWith('oauth-client-1')
})

test('mint rejects an eleventh active client and deletes the unused provider client', async () => {
	const { db } = createMigratedDb()
	const helpers = providerHelpers()
	await mintClients(db, maxUserMcpOauthClients, helpers)

	expect(
		await mintUserMcpOauthClient({
			db,
			helpers,
			userId: 1,
			label: 'Too many',
			redirectUris: [callback],
		}),
	).toMatchObject({ ok: false, status: 400 })
	expect(helpers.createClient).toHaveBeenCalledTimes(maxUserMcpOauthClients)
	expect(helpers.deleteClient).not.toHaveBeenCalled()
	expect(await listActiveUserMcpOauthClientIds(db, 1)).toHaveLength(
		maxUserMcpOauthClients,
	)
})

test('quota-race mint keeps a revoked ownership row when deleteClient fails', async () => {
	const { sqlite, db } = createMigratedDb()
	await mintClients(db, maxUserMcpOauthClients - 1)
	const deleteClient = vi.fn(async () => {
		throw new Error('provider delete failed')
	})

	const raced = await mintUserMcpOauthClient({
		db,
		helpers: {
			createClient: async () => {
				sqlite.exec(`
					INSERT INTO user_mcp_oauth_clients (
						id, user_id, client_id, label, redirect_uris_json, created_at
					) VALUES (
						'seeded-tenth', 1, 'oauth-client-tenth', 'Tenth',
						'["https://example.com/callback"]', '2026-08-21T00:00:00.000Z'
					);
				`)
				return { clientId: 'oauth-client-race', clientSecret: 'secret' }
			},
			deleteClient,
		},
		userId: 1,
		label: 'Raced',
		redirectUris: [callback],
	})
	expect(raced).toMatchObject({ ok: false, status: 400 })
	expect(deleteClient).toHaveBeenCalledWith('oauth-client-race')
	expect(await listActiveUserMcpOauthClientIds(db, 1)).toHaveLength(
		maxUserMcpOauthClients,
	)
	const raceRows = (await listUserMcpOauthClients(db, 1)).filter(
		(client) => client.clientId === 'oauth-client-race',
	)
	expect(raceRows).toEqual([
		expect.objectContaining({ revokedAt: expect.any(String) }),
	])
})
