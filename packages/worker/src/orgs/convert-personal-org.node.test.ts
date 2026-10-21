import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import {
	decryptSecretValue,
	decryptUserOauthAccessToken,
	encryptSecretValue,
	encryptUserOauthAccessToken,
	userIntegrationCredentialContext,
	userSecretContext,
} from '#mcp/secrets/crypto.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	type ConvertPersonalOrgError,
	convertPersonalOrg,
} from './convert-personal-org.ts'
import { isPersonalOrg } from './is-personal-org.ts'
import { provisionPersonalOrg } from './provision.ts'

const hubMock = vi.hoisted(() => {
	const calls: Array<string> = []
	let failImportOnServerId: string | null = null
	let throwOnDiscardServerId: string | null = null
	let usernameAtFirstImport: string | null = null
	let readUsername: (() => Promise<string | null>) | null = null
	return {
		calls,
		reset() {
			calls.length = 0
			failImportOnServerId = null
			throwOnDiscardServerId = null
			usernameAtFirstImport = null
			readUsername = null
		},
		failImportOn(serverId: string) {
			failImportOnServerId = serverId
		},
		throwOnDiscard(serverId: string) {
			throwOnDiscardServerId = serverId
		},
		observeUsername(reader: () => Promise<string | null>) {
			readUsername = reader
		},
		usernameAtFirstImport: () => usernameAtFirstImport,
		stub: ({ userId }: { userId: string }) => ({
			exportServerForTransfer: async ({ serverId }: { serverId: string }) => {
				calls.push(`export:${userId}:${serverId}`)
				return {
					row: {
						id: serverId,
						name: serverId,
						server_url: 'https://mcp.example.com',
						client_id: null,
						auth_url: null,
						callback_url: 'https://kody.codes/mcp/callback',
						server_options: null,
					},
					entries: [] as Array<[string, unknown]>,
				}
			},
			importServerForTransfer: async (transfer: { row: { id: string } }) => {
				calls.push(`import:${userId}:${transfer.row.id}`)
				if (usernameAtFirstImport === null && readUsername) {
					usernameAtFirstImport = await readUsername()
				}
				if (failImportOnServerId === transfer.row.id) {
					return { ok: false as const, reason: 'already_registered' as const }
				}
				return { ok: true as const }
			},
			removeServerForTransfer: async ({ serverId }: { serverId: string }) => {
				calls.push(`remove:${userId}:${serverId}`)
			},
			connectTransferredServer: async ({ serverId }: { serverId: string }) => {
				calls.push(`connect:${userId}:${serverId}`)
				return { ok: true as const }
			},
			discardTransferredServer: async ({ serverId }: { serverId: string }) => {
				calls.push(`discard:${userId}:${serverId}`)
				if (throwOnDiscardServerId === serverId) {
					throw new Error('discard boom')
				}
			},
			listServerIdsForTransfer: async () => [],
		}),
	}
})

vi.mock('#worker/mcp-client/hub-transfer.ts', () => ({
	mcpClientHubTransferStub: hubMock.stub,
}))

beforeEach(() => {
	hubMock.reset()
})

vi.mock('#mcp/memory/memory-vectorize.ts', () => ({
	deleteMemoryVector: async (_env: unknown, _memoryId: string) => {},
	upsertMemoryVector: async () => {},
}))

const cryptoEnv = { SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum' }
const now = '2026-10-17T00:00:00.000Z'
const pkgId = '11111111-1111-4111-8111-111111111111'

async function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = {
		...cryptoEnv,
		APP_DB: db,
		APP_BASE_URL: 'https://kody.codes',
	} as unknown as Env
	return { sqlite, db, env }
}

async function seedEqualIdPerson(
	db: D1Database,
	input: {
		email: string
		username: string
		displayName?: string
		avatarKey?: string
	},
) {
	const personId = testStableUserIdFromEmail(input.email)
	await db
		.prepare(
			`INSERT INTO users (
				email, username, password_hash, stable_user_id,
				display_name, avatar_key, created_at, updated_at
			) VALUES (?, ?, 'hash', ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.email,
			input.username,
			personId,
			input.displayName ?? null,
			input.avatarKey ?? null,
			now,
			now,
		)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId: personId,
		username: input.username,
		createdAt: now,
		displayName: input.displayName ?? input.username,
		avatarKey: input.avatarKey ?? null,
		plan: 'free',
	})
	return personIdFromStored(personId)
}

async function seedOwnedSurfaces(
	db: D1Database,
	ownerId: OwnerId,
	personId: string,
) {
	await db
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES (?, ?, '@owner/alpha', 'alpha', 'desc', 'src-alpha')`,
		)
		.bind(pkgId, ownerId)
		.run()
	await db
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, subject, summary, created_at, updated_at
			) VALUES ('mem-1', ?, 'demo', 'summary', ?, ?)`,
		)
		.bind(ownerId, now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO secret_buckets (id, user_id, scope, binding_key)
			 VALUES ('bucket-user', ?, 'user', '')`,
		)
		.bind(ownerId)
		.run()
	const secretCipher = await encryptSecretValue(
		cryptoEnv,
		'user-secret-plaintext',
		userSecretContext(ownerId),
	)
	await db
		.prepare(
			`INSERT INTO secret_entries (id, bucket_id, name, encrypted_value)
			 VALUES ('cred-personal', 'bucket-user', 'API_KEY', ?)`,
		)
		.bind(secretCipher)
		.run()
	await db
		.prepare(
			`INSERT INTO user_oauth_apps (
				user_id, slug, provider, client_id, token_url, flow
			) VALUES (?, 'myapp', 'github', 'client-1', 'https://example.com/token', 'confidential')`,
		)
		.bind(ownerId)
		.run()
	await db
		.prepare(
			`INSERT INTO user_integrations (
				id, user_id, name, app_slug, access_token_encrypted
			) VALUES ('int-1', ?, 'github', 'myapp', ?)`,
		)
		.bind(
			ownerId,
			await encryptUserOauthAccessToken(
				cryptoEnv,
				'access-token-plain',
				userIntegrationCredentialContext(ownerId, 'github'),
			),
		)
		.run()
	await db
		.prepare(
			`INSERT INTO webhook_endpoints (
				id, user_id, package_id, webhook_name, url_secret_hash,
				created_at, rotated_at
			) VALUES ('hook-1', ?, ?, 'ping', 'hash-1', ?, ?)`,
		)
		.bind(ownerId, pkgId, now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO api_tokens (
				id, user_id, org_id, name, token_hash, scopes_json,
				idle_ttl_seconds, expires_at, max_expires_at, created_via,
				created_at, updated_at
			) VALUES (
				'token-1', ?, ?, 'cli', 'hash', '[]',
				3600, ?, ?, 'test', ?, ?
			)`,
		)
		.bind(personId, ownerId, now, now, now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO follows (
				id, follower_org_id, creator_user_id, target_kind,
				target_owner_id, target_id, target_name, status,
				created_at, updated_at
			) VALUES (
				'follow-1', 'other-org', ?, 'package',
				?, ?, 'alpha', 'active', ?, ?
			)`,
		)
		.bind(personId, personId, pkgId, now, now)
		.run()
}

test('convertPersonalOrg demotes equal-id personal org and moves person surfaces', async () => {
	const { db, env } = await createHarness()
	const personId = await seedEqualIdPerson(db, {
		email: 'ada@example.com',
		username: 'ada',
		displayName: 'Ada Lovelace',
		avatarKey: 'avatars/ada.png',
	})
	const convertedOrgId = personalOrgId(personId)
	await seedOwnedSurfaces(db, convertedOrgId, personId)

	await db
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES ('other-org', 'other-org', 'free', ?, ?)`,
		)
		.bind(now, now)
		.run()

	const result = await convertPersonalOrg({
		env,
		personId,
		newHandle: 'ada-codes',
		now: new Date(now),
	})

	expect(result.convertedSlug).toBe('ada')
	expect(result.newUsername).toBe('ada-codes')
	expect(result.convertedOrgId).toBe(convertedOrgId)
	expect(result.newPersonalOrgId).not.toBe(convertedOrgId)
	expect(result.moved.memories).toBe(1)
	expect(result.moved.userSecrets).toBe(1)
	expect(result.moved.integrations).toBe(1)
	expect(result.moved.apiTokens).toBe(1)

	const user = await db
		.prepare(
			`SELECT username, personal_org_id, display_name, avatar_key
			 FROM users WHERE stable_user_id = ?`,
		)
		.bind(personId)
		.first<{
			username: string
			personal_org_id: string
			display_name: string | null
			avatar_key: string | null
		}>()
	expect(user).toMatchObject({
		username: 'ada-codes',
		personal_org_id: result.newPersonalOrgId,
		display_name: 'Ada Lovelace',
		avatar_key: 'avatars/ada.png',
	})
	expect(await isPersonalOrg(db, convertedOrgId)).toBe(false)
	expect(await isPersonalOrg(db, result.newPersonalOrgId)).toBe(true)

	const convertedOrg = await db
		.prepare(
			`SELECT slug, display_name, avatar_key, plan FROM orgs WHERE id = ?`,
		)
		.bind(convertedOrgId)
		.first<{
			slug: string
			display_name: string | null
			avatar_key: string | null
			plan: string
		}>()
	expect(convertedOrg).toMatchObject({
		slug: 'ada',
		display_name: 'Ada Lovelace',
		avatar_key: 'avatars/ada.png',
		plan: 'free',
	})

	const newOrg = await db
		.prepare(
			`SELECT slug, display_name, avatar_key, plan FROM orgs WHERE id = ?`,
		)
		.bind(result.newPersonalOrgId)
		.first<{
			slug: string
			display_name: string | null
			avatar_key: string | null
			plan: string
		}>()
	expect(newOrg).toMatchObject({
		slug: 'ada-codes',
		display_name: 'Ada Lovelace',
		avatar_key: 'avatars/ada.png',
		plan: 'free',
	})

	const oldHandle = await db
		.prepare(`SELECT user_id, org_id FROM handles WHERE handle = 'ada'`)
		.first<{ user_id: string | null; org_id: string }>()
	expect(oldHandle).toEqual({ user_id: null, org_id: convertedOrgId })
	const newHandle = await db
		.prepare(`SELECT user_id, org_id FROM handles WHERE handle = 'ada-codes'`)
		.first<{ user_id: string | null; org_id: string }>()
	expect(newHandle).toEqual({
		user_id: personId,
		org_id: result.newPersonalOrgId,
	})

	expect(
		await db
			.prepare(`SELECT user_id FROM saved_packages WHERE id = ?`)
			.bind(pkgId)
			.first(),
	).toEqual({ user_id: convertedOrgId })
	expect(
		await db
			.prepare(`SELECT user_id FROM webhook_endpoints WHERE id = 'hook-1'`)
			.first(),
	).toEqual({ user_id: convertedOrgId })
	expect(
		await db
			.prepare(`SELECT user_id FROM mcp_memories WHERE id = 'mem-1'`)
			.first(),
	).toEqual({ user_id: result.newPersonalOrgId })
	expect(
		await db
			.prepare(`SELECT user_id FROM secret_buckets WHERE id = 'bucket-user'`)
			.first(),
	).toEqual({ user_id: result.newPersonalOrgId })
	expect(
		await db
			.prepare(`SELECT user_id FROM user_integrations WHERE id = 'int-1'`)
			.first(),
	).toEqual({ user_id: result.newPersonalOrgId })
	expect(
		await db
			.prepare(`SELECT org_id FROM api_tokens WHERE id = 'token-1'`)
			.first(),
	).toEqual({ org_id: result.newPersonalOrgId })

	const secret = await db
		.prepare(
			`SELECT encrypted_value FROM secret_entries WHERE name = 'API_KEY'`,
		)
		.first<{ encrypted_value: string }>()
	expect(
		await decryptSecretValue(
			cryptoEnv,
			secret!.encrypted_value,
			userSecretContext(result.newPersonalOrgId),
		),
	).toBe('user-secret-plaintext')

	const integration = await db
		.prepare(
			`SELECT access_token_encrypted FROM user_integrations WHERE id = 'int-1'`,
		)
		.first<{ access_token_encrypted: string }>()
	expect(
		await decryptUserOauthAccessToken(
			cryptoEnv,
			integration!.access_token_encrypted,
			userIntegrationCredentialContext(result.newPersonalOrgId, 'github'),
		),
	).toBe('access-token-plain')

	// Equal-id: follows already named the converted org id; no rewrite needed.
	expect(
		await db
			.prepare(`SELECT target_owner_id FROM follows WHERE id = 'follow-1'`)
			.first(),
	).toEqual({ target_owner_id: convertedOrgId })

	const inbox = await db
		.prepare(
			`SELECT address FROM email_inbox_addresses
			 WHERE user_id = ? AND deleted_at IS NULL`,
		)
		.bind(result.newPersonalOrgId)
		.first<{ address: string }>()
	expect(inbox?.address).toBe('ada-codes@inbox.kody.codes')
})

test('convertPersonalOrg refuses while personal credentials are granted into other orgs', async () => {
	const { db, env } = await createHarness()
	const personId = await seedEqualIdPerson(db, {
		email: 'granted@example.com',
		username: 'granted',
	})
	const convertedOrgId = personalOrgId(personId)
	await seedOwnedSurfaces(db, convertedOrgId, personId)
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES ('elsewhere', 'elsewhere', 'free', ?, ?)`,
		)
		.bind(now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO credential_org_grants (
				credential_id, user_id, org_id, created_at
			) VALUES ('cred-personal', ?, 'elsewhere', ?)`,
		)
		.bind(personId, now)
		.run()

	await expect(
		convertPersonalOrg({
			env,
			personId,
			newHandle: 'granted-new',
			now: new Date(now),
		}),
	).rejects.toMatchObject({
		name: 'ConvertPersonalOrgError',
		code: 'credential_grants',
		message: expect.stringContaining('API_KEY'),
	} satisfies Partial<ConvertPersonalOrgError>)
	expect(
		await db
			.prepare(`SELECT username FROM users WHERE stable_user_id = ?`)
			.bind(personId)
			.first(),
	).toEqual({ username: 'granted' })
})

test('convertPersonalOrg surfaces the same reserved error as username signup', async () => {
	const { db, env } = await createHarness()
	const personId = await seedEqualIdPerson(db, {
		email: 'reserved@example.com',
		username: 'reserved-user',
	})
	for (const newHandle of ['admin', 'me', 'ME', 'kody']) {
		await expect(
			convertPersonalOrg({
				env,
				personId,
				newHandle,
				now: new Date(now),
			}),
		).rejects.toMatchObject({
			name: 'ConvertPersonalOrgError',
			code: 'invalid_handle',
			message: 'This username is reserved.',
		} satisfies Partial<ConvertPersonalOrgError>)
	}
	expect(
		await db
			.prepare(`SELECT username FROM users WHERE stable_user_id = ?`)
			.bind(personId)
			.first(),
	).toEqual({ username: 'reserved-user' })
	expect(
		await db
			.prepare(
				`SELECT COUNT(*) AS count FROM orgs WHERE slug IN ('admin', 'me', 'kody')`,
			)
			.first<{ count: number }>(),
	).toEqual({ count: 0 })
})

test('convertPersonalOrg stages MCP hub transfers before identity rewrite and discards on import failure', async () => {
	const { db, env } = await createHarness()
	const personId = await seedEqualIdPerson(db, {
		email: 'mcp@example.com',
		username: 'mcp-user',
	})
	const convertedOrgId = personalOrgId(personId)
	;(env as { MCP_CLIENT_HUB?: unknown }).MCP_CLIENT_HUB = {}
	await db
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url)
			 VALUES ('srv-a', ?, 'alpha', 'https://a.example.com'),
			        ('srv-b', ?, 'beta', 'https://b.example.com')`,
		)
		.bind(convertedOrgId, convertedOrgId)
		.run()

	hubMock.failImportOn('srv-b')
	hubMock.observeUsername(async () => {
		const row = await db
			.prepare(`SELECT username FROM users WHERE stable_user_id = ?`)
			.bind(personId)
			.first<{ username: string }>()
		return row?.username ?? null
	})

	await expect(
		convertPersonalOrg({
			env,
			personId,
			newHandle: 'mcp-new',
			now: new Date(now),
		}),
	).rejects.toMatchObject({
		name: 'ConvertPersonalOrgError',
		code: 'failed',
		message: 'Unable to import MCP server "beta" during conversion.',
	})

	expect(hubMock.usernameAtFirstImport()).toBe('mcp-user')
	expect(
		await db
			.prepare(`SELECT username FROM users WHERE stable_user_id = ?`)
			.bind(personId)
			.first(),
	).toEqual({ username: 'mcp-user' })
	expect(await isPersonalOrg(db, convertedOrgId)).toBe(true)
	expect(
		await db
			.prepare(`SELECT id, user_id FROM mcp_server_settings ORDER BY id`)
			.all(),
	).toMatchObject({
		results: [
			{ id: 'srv-a', user_id: convertedOrgId },
			{ id: 'srv-b', user_id: convertedOrgId },
		],
	})
	expect(hubMock.calls.some((call) => call.startsWith('remove:'))).toBe(false)
	expect(hubMock.calls.some((call) => call.startsWith('connect:'))).toBe(false)
	expect(
		hubMock.calls.some(
			(call) => call.startsWith('discard:') && call.endsWith(':srv-a'),
		),
	).toBe(true)
})

test('convertPersonalOrg preserves import error when staged discard fails', async () => {
	const { db, env } = await createHarness()
	const personId = await seedEqualIdPerson(db, {
		email: 'mcp-discard@example.com',
		username: 'mcp-discard',
	})
	const convertedOrgId = personalOrgId(personId)
	;(env as { MCP_CLIENT_HUB?: unknown }).MCP_CLIENT_HUB = {}
	await db
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url)
			 VALUES ('srv-keep', ?, 'keep', 'https://keep.example.com'),
			        ('srv-fail', ?, 'fail', 'https://fail.example.com')`,
		)
		.bind(convertedOrgId, convertedOrgId)
		.run()

	hubMock.failImportOn('srv-fail')
	hubMock.throwOnDiscard('srv-keep')

	await expect(
		convertPersonalOrg({
			env,
			personId,
			newHandle: 'mcp-discard-new',
			now: new Date(now),
		}),
	).rejects.toMatchObject({
		name: 'ConvertPersonalOrgError',
		code: 'failed',
		message: 'Unable to import MCP server "fail" during conversion.',
	})
	expect(
		hubMock.calls.some(
			(call) => call.startsWith('discard:') && call.endsWith(':srv-keep'),
		),
	).toBe(true)
})

test('convertPersonalOrg finalizes MCP remove/connect only after identity rewrite', async () => {
	const { db, env } = await createHarness()
	const personId = await seedEqualIdPerson(db, {
		email: 'mcp-ok@example.com',
		username: 'mcp-ok',
	})
	const convertedOrgId = personalOrgId(personId)
	;(env as { MCP_CLIENT_HUB?: unknown }).MCP_CLIENT_HUB = {}
	await db
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url)
			 VALUES ('srv-ok', ?, 'ok', 'https://ok.example.com')`,
		)
		.bind(convertedOrgId)
		.run()

	hubMock.observeUsername(async () => {
		const row = await db
			.prepare(`SELECT username FROM users WHERE stable_user_id = ?`)
			.bind(personId)
			.first<{ username: string }>()
		return row?.username ?? null
	})

	const result = await convertPersonalOrg({
		env,
		personId,
		newHandle: 'mcp-ok-new',
		now: new Date(now),
	})

	expect(result.moved.mcpServers).toBe(1)
	expect(hubMock.usernameAtFirstImport()).toBe('mcp-ok')
	expect(hubMock.calls).toEqual([
		`export:${convertedOrgId}:srv-ok`,
		`import:${result.newPersonalOrgId}:srv-ok`,
		`remove:${convertedOrgId}:srv-ok`,
		`connect:${result.newPersonalOrgId}:srv-ok`,
	])
	expect(
		await db
			.prepare(`SELECT user_id FROM mcp_server_settings WHERE id = 'srv-ok'`)
			.first(),
	).toEqual({ user_id: result.newPersonalOrgId })
})

test('convertPersonalOrg refuses when minting the new free personal org would exceed the free-org cap', async () => {
	const { db, env } = await createHarness()
	const personId = await seedEqualIdPerson(db, {
		email: 'capped@example.com',
		username: 'capped',
	})
	await db
		.prepare(
			`INSERT INTO orgs (
				id, slug, plan, entitlement_ladder, created_at, updated_at
			) VALUES ('free-team', 'free-team', 'free', 'public', ?, ?)`,
		)
		.bind(now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES ('free-team', ?, 'owner', ?)`,
		)
		.bind(personId, now)
		.run()

	await expect(
		convertPersonalOrg({
			env,
			personId,
			newHandle: 'capped-new',
			now: new Date(now),
		}),
	).rejects.toMatchObject({
		name: 'ConvertPersonalOrgError',
		code: 'free_org_cap',
		message: expect.stringMatching(/2 free organizations/),
	})
})

test('convertPersonalOrg retargets follows when personal org id differs from person id', async () => {
	const { db, env } = await createHarness()
	const personId = testStableUserIdFromEmail('distinct@example.com')
	const personalOrgId = ownerIdFromStored('org-personal-distinct')
	await db
		.prepare(
			`INSERT INTO users (
				email, username, password_hash, stable_user_id,
				personal_org_id, display_name, created_at, updated_at
			) VALUES (
				'distinct@example.com', 'distinct', 'hash', ?, ?, 'Distinct', ?, ?
			)`,
		)
		.bind(personId, personalOrgId, now, now)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId: personId,
		orgId: personalOrgId,
		username: 'distinct',
		createdAt: now,
		displayName: 'Distinct',
		plan: 'free',
	})
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES ('follower', 'follower', 'free', ?, ?)`,
		)
		.bind(now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO follows (
				id, follower_org_id, creator_user_id, target_kind,
				target_owner_id, target_id, target_name, status,
				created_at, updated_at
			) VALUES (
				'follow-person', 'follower', ?, 'package',
				?, 'pkg-x', 'x', 'active', ?, ?
			)`,
		)
		.bind(personId, personId, now, now)
		.run()

	const result = await convertPersonalOrg({
		env,
		personId: personIdFromStored(personId),
		newHandle: 'distinct-new',
		now: new Date(now),
	})

	expect(result.convertedOrgId).toBe(personalOrgId)
	expect(result.moved.followsRetargeted).toBe(1)
	expect(
		await db
			.prepare(`SELECT target_owner_id FROM follows WHERE id = 'follow-person'`)
			.first(),
	).toEqual({ target_owner_id: personalOrgId })
})

function conversionSnapshot(sqlite: DatabaseSync) {
	return Object.fromEntries(
		[
			'users',
			'orgs',
			'org_memberships',
			'handles',
			'secret_entries',
			'secret_buckets',
			'user_oauth_apps',
			'user_integrations',
			'mcp_memories',
			'mcp_server_settings',
			'api_tokens',
			'grants',
			'follows',
		].map((table) => [
			table,
			sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
		]),
	)
}

test('credential preparation failure leaves identity, ownership, and earlier ciphertext unchanged', async () => {
	const { sqlite, db, env } = await createHarness()
	const personId = await seedEqualIdPerson(db, {
		email: 'prepare-failure@example.com',
		username: 'prepare-failure',
	})
	await seedOwnedSurfaces(db, personalOrgId(personId), personId)
	// Secret preparation succeeds first, then this integration fails to decrypt.
	sqlite.exec(
		`UPDATE user_integrations SET access_token_encrypted = 'invalid-ciphertext'`,
	)
	const before = conversionSnapshot(sqlite)
	await expect(
		convertPersonalOrg({
			env,
			personId,
			newHandle: 'prepare-new',
			now: new Date(now),
		}),
	).rejects.toThrow(/./)
	expect(conversionSnapshot(sqlite)).toEqual(before)
	expect(hubMock.calls).toEqual([])
})

test('a late D1 failure rolls back identity, ciphertext, resource owners and staged MCP imports', async () => {
	const { sqlite, db, env } = await createHarness()
	const personId = await seedEqualIdPerson(db, {
		email: 'batch-failure@example.com',
		username: 'batch-failure',
	})
	const oldOrgId = personalOrgId(personId)
	await seedOwnedSurfaces(db, oldOrgId, personId)
	;(env as { MCP_CLIENT_HUB?: unknown }).MCP_CLIENT_HUB = {}
	await db
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url) VALUES ('srv-atomic', ?, 'atomic', 'https://mcp.example.com')`,
		)
		.bind(oldOrgId)
		.run()
	sqlite.exec(
		`CREATE TRIGGER fail_conversion_token BEFORE UPDATE OF org_id ON api_tokens BEGIN SELECT RAISE(ABORT, 'token owner write failed'); END`,
	)
	const before = conversionSnapshot(sqlite)
	await expect(
		convertPersonalOrg({
			env,
			personId,
			newHandle: 'batch-new',
			now: new Date(now),
		}),
	).rejects.toThrow('token owner write failed')
	expect(conversionSnapshot(sqlite)).toEqual(before)
	expect(hubMock.calls.some((call) => call.startsWith('import:'))).toBe(true)
	expect(hubMock.calls.some((call) => call.startsWith('discard:'))).toBe(true)
	expect(
		hubMock.calls.some(
			(call) => call.startsWith('remove:') || call.startsWith('connect:'),
		),
	).toBe(false)
	const secret = await db
		.prepare(
			`SELECT encrypted_value FROM secret_entries WHERE id = 'cred-personal'`,
		)
		.first<{ encrypted_value: string }>()
	expect(
		await decryptSecretValue(
			cryptoEnv,
			secret!.encrypted_value,
			userSecretContext(oldOrgId),
		),
	).toBe('user-secret-plaintext')
})

test('a failed email followup reports committed conversion instead of offering a second conversion', async () => {
	const { sqlite, db, env } = await createHarness()
	const personId = await seedEqualIdPerson(db, {
		email: 'followup@example.com',
		username: 'followup-old',
	})
	sqlite.exec(
		`CREATE TRIGGER fail_conversion_inbox BEFORE INSERT ON email_inboxes BEGIN SELECT RAISE(ABORT, 'inbox unavailable'); END`,
	)
	const result = await convertPersonalOrg({
		env,
		personId,
		newHandle: 'followup-new',
		now: new Date(now),
	})
	expect(result.followUpFailures).toContain('email_inbox')
	expect(
		await db
			.prepare(
				`SELECT username, personal_org_id FROM users WHERE stable_user_id = ?`,
			)
			.bind(personId)
			.first(),
	).toEqual({
		username: 'followup-new',
		personal_org_id: result.newPersonalOrgId,
	})
	expect(await isPersonalOrg(db, result.convertedOrgId)).toBe(false)
	expect(await isPersonalOrg(db, result.newPersonalOrgId)).toBe(true)
})
