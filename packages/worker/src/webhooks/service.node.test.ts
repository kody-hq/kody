import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	decryptWebhookUrlSecret,
	userWebhookUrlSecretContext,
} from '#mcp/secrets/crypto.ts'
import {
	disableEnablement,
	insertEnablement,
} from '#worker/enablements/repo.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { hashWebhookUrlSecret } from './crypto.ts'
import { WebhookEndpointIdRaceError } from './errors.ts'
import { parseWebhookUrlHandle } from './handle.ts'
import * as webhookRepo from './repo.ts'
import {
	listWebhooksForUser,
	mintWebhookUrlForUser,
	revealWebhookUrlForWebsite,
	rotateWebhookUrlForUser,
	setWebhookEnabledForUser,
} from './service.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

vi.mock('#worker/credentials/self-published-package-guard.ts', () => ({
	assertSelfPublishedPackageResolvesNothing: async () => {},
}))

vi.mock('#mcp/secrets/service.ts', () => {
	const resolveSecret = vi.fn(async (_input: unknown) => ({
		found: true,
		credentialId: 'cred-legacy-webhook-secret',
		value: 'legacy-sentry-webhook-secret',
		allowedHosts: [],
		allowedPackages: ['pkg-1'],
		scope: 'user',
	}))
	return {
		resolveSecret,
		findSecretForUse: vi.fn(async (input: unknown) => {
			const resolved = await resolveSecret(input)
			const { value: _value, ...found } = resolved
			return { found, readValue: async () => resolved }
		}),
	}
})

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: vi.fn(
		async (input: { userId: string; packageIdOrKodyId: string }) => {
			if (
				input.packageIdOrKodyId === 'pkg-1' ||
				input.packageIdOrKodyId === 'sentry-bridge'
			) {
				return {
					id: 'pkg-1',
					kodyId: 'sentry-bridge',
					name: '@owner/sentry-bridge',
					userId: input.userId,
					sourceId: 'src-1',
				}
			}
			return null
		},
	),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: vi.fn(
		async (_db: unknown, input: { userId: string }) => [
			{
				id: 'pkg-1',
				userId: ownerIdFromStored(input.userId),
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
		],
	),
	resolveSavedPackageRef: vi.fn(),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: vi.fn(async () => ({
		manifest: {
			name: '@owner/sentry-bridge',
			exports: {
				'./handle-sentry-webhook': './src/handle-sentry-webhook.ts',
			},
			kody: {
				id: 'sentry-bridge',
				description: 'Sentry bridge',
				webhooks: [
					{
						name: 'sentry',
						export: './handle-sentry-webhook',
						responseMode: 'ack',
						verification: {
							type: 'hmac-sha256',
							header: 'sentry-hook-signature',
							secretName: 'sentryWebhookSecret',
							encoding: 'hex',
						},
					},
				],
			},
		},
	})),
}))

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		APP_BASE_URL: 'https://heykody.dev',
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
	return { env, db, sqlite }
}

const sentryHook = { kodyId: 'sentry-bridge', webhookName: 'sentry' }

async function setupOwner(email: string, username: string) {
	const userId = testStableUserIdFromEmail(email)
	const { env, db, sqlite } = createEnv()
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES (?, ?, 'hash', ?)`,
		)
		.bind(username, email, userId)
		.run()
	await provisionPersonalOrgForSqliteUser(sqlite, {
		stableUserId: userId,
		username,
	})
	const input = {
		env,
		request: sessionRequestContext(userId),
		userId: ownerIdFromStored(userId),
		username,
		...sentryHook,
	}
	return {
		env,
		db,
		userId,
		mint: () => mintWebhookUrlForUser(input),
		rotate: () => rotateWebhookUrlForUser(input),
		list: (forUserId = userId) =>
			listWebhooksForUser({
				env,
				request: sessionRequestContext(forUserId),
				baseUrl: 'https://heykody.dev',
				userId: ownerIdFromStored(forUserId),
			}),
		readEndpoint: <T>(endpointId: string, columns: string) =>
			db
				.prepare(`SELECT ${columns} FROM webhook_endpoints WHERE id = ?`)
				.bind(endpointId)
				.first<T>(),
	}
}

const urlSecretOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)

test('minting never turns a webhook on: it links to Approve until someone has, and an existing enablement survives remint and rotate', async () => {
	const owner = await setupOwner('approver@example.com', 'approver')
	const { env, db, userId } = owner
	const input = {
		env,
		request: sessionRequestContext(userId, 'approver'),
		userId: ownerIdFromStored(userId),
		username: 'approver',
		...sentryHook,
	}
	const listNow = () =>
		listWebhooksForUser({
			env,
			request: input.request,
			baseUrl: 'https://heykody.dev',
			userId: input.userId,
		})
	const webhookEnablements = () =>
		db
			.prepare(
				`SELECT id, state, origin FROM enablements WHERE trigger_kind = 'webhook'`,
			)
			.all<{ id: string; state: string; origin: string }>()
			.then((result) => result.results)

	expect(await listNow()).toMatchObject([
		{ minted: false, approved: false, approvalUrl: null },
	])

	const minted = await mintWebhookUrlForUser(input)
	expect(minted.approvalUrl).toBe(
		`https://heykody.dev/@approver/sentry-bridge/approve-credentials?enable=webhook%3Asentry%3A${minted.endpointId}`,
	)
	expect(await webhookEnablements()).toEqual([])
	// The list carries the same Approve link and no approval yet, even though
	// the endpoint itself is enabled.
	expect(await listNow()).toMatchObject([
		{
			minted: true,
			enabled: true,
			approved: false,
			approvalUrl: minted.approvalUrl,
		},
	])

	// Neither a second mint nor a rotate enables it behind the person's back.
	expect((await mintWebhookUrlForUser(input)).approvalUrl).toBe(
		minted.approvalUrl,
	)
	expect((await rotateWebhookUrlForUser(input)).approvalUrl).toBe(
		minted.approvalUrl,
	)
	expect(await webhookEnablements()).toEqual([])

	// An enablement from before this change (migrated, or minted under the old
	// shortcut) keeps working, and the mint no longer asks for approval.
	const existing = await insertEnablement({
		db,
		enablement: {
			orgId: ownerIdFromStored(userId),
			packageId: 'pkg-1',
			triggerKind: 'webhook',
			triggerName: 'sentry',
			instanceId: parseWebhookUrlHandle(minted.handle)!,
			enablerUserId: personIdFromStored(userId),
			origin: 'migrated',
		},
	})
	expect((await mintWebhookUrlForUser(input)).approvalUrl).toBeNull()
	expect((await rotateWebhookUrlForUser(input)).approvalUrl).toBeNull()
	expect(await webhookEnablements()).toEqual([
		{ id: existing.id, state: 'on', origin: 'migrated' },
	])
	expect(await listNow()).toMatchObject([
		{ minted: true, approved: true, approvalUrl: null },
	])

	// An off enablement no longer counts as approval.
	await disableEnablement({
		db,
		orgId: ownerIdFromStored(userId),
		id: existing.id,
	})
	expect(await listNow()).toMatchObject([
		{ approved: false, approvalUrl: minted.approvalUrl },
	])
})

test('mint/list/rotate/enable/disable webhooks are package-centered and user-scoped', async () => {
	const owner = await setupOwner('owner@example.com', 'owner')
	const { env, userId } = owner
	const otherUserId = testStableUserIdFromEmail('other@example.com')

	const listedBefore = await owner.list()
	expect(listedBefore).toHaveLength(1)
	expect(listedBefore[0]).toMatchObject({
		minted: false,
		urlRecoverable: false,
		verification: { secretName: 'sentryWebhookSecret' },
		inputMode: 'request',
		rateLimitPerMinute: 60,
	})

	const minted = await mintWebhookUrlForUser({
		env,
		request: sessionRequestContext(userId),
		userId: ownerIdFromStored(userId),
		email: 'owner@example.com',
		username: 'owner',
		...sentryHook,
	})
	expect(minted.handle.startsWith('whh_')).toBe(true)
	expect(minted.urlHost).toBe('heykody.dev')
	for (const secretKey of ['url', 'urlSecret', 'url_secret']) {
		expect(minted).not.toHaveProperty(secretKey)
	}

	const mintedEndpointId = parseWebhookUrlHandle(minted.handle)!
	const mintedHmac = await owner.readEndpoint<{
		hmac_secret_encrypted: string | null
	}>(mintedEndpointId, 'hmac_secret_encrypted')
	expect(mintedHmac?.hmac_secret_encrypted).toBeTruthy()

	const reveal = (
		target: Parameters<typeof revealWebhookUrlForWebsite>[0]['target'],
	) =>
		revealWebhookUrlForWebsite({
			env,
			userId: ownerIdFromStored(userId),
			username: 'owner',
			target,
		})
	const revealed = await reveal({ handle: minted.handle })
	expect(revealed.url).toContain('/@owner/webhooks/sentry-bridge/sentry/')
	expect(revealed.urlHost).toBe('heykody.dev')
	expect(revealed).not.toHaveProperty('signingSecret')
	// The account UI addresses a webhook by package + name rather than by
	// handle; both paths resolve the same minted URL.
	expect(await reveal(sentryHook)).toMatchObject({
		url: revealed.url,
		handle: minted.handle,
	})

	const listed = await owner.list()
	expect(listed[0]).toMatchObject({
		minted: true,
		enabled: true,
		handle: minted.handle,
		urlHost: 'heykody.dev',
		urlRecoverable: true,
	})
	expect(listed[0]).not.toHaveProperty('url')
	expect(JSON.stringify(listed)).not.toContain(revealed.url)
	expect(JSON.stringify(listed)).not.toContain(urlSecretOf(revealed.url))

	// Mock returns the same packages for any userId — still no mint rows for other.
	expect((await owner.list(otherUserId))[0]?.minted).toBe(false)

	const rotated = await owner.rotate()
	expect(rotated.handle).toBe(minted.handle)
	expect(rotated).not.toHaveProperty('url')
	const stored = await owner.db
		.prepare(
			`SELECT id, url_secret_hash, url_secret_encrypted,
				previous_url_secret_hash, previous_url_secret_expires_at
			FROM webhook_endpoints
			WHERE user_id = ? AND package_id = 'pkg-1' AND webhook_name = 'sentry'`,
		)
		.bind(userId)
		.first<{
			id: string
			url_secret_hash: string
			url_secret_encrypted: string
			previous_url_secret_hash: string
			previous_url_secret_expires_at: string
		}>()
	const endpointId = parseWebhookUrlHandle(rotated.handle)!
	expect(stored?.id).toBe(endpointId)
	expect(stored?.url_secret_encrypted).toBeTruthy()
	const rotatedSecret = await decryptWebhookUrlSecret(
		env,
		stored!.url_secret_encrypted,
		userWebhookUrlSecretContext(ownerIdFromStored(userId), endpointId),
	)
	const previousSecret = urlSecretOf(revealed.url)
	expect(rotatedSecret).not.toBe(previousSecret)
	expect(stored).toMatchObject({
		url_secret_hash: await hashWebhookUrlSecret(rotatedSecret),
		previous_url_secret_hash: await hashWebhookUrlSecret(previousSecret),
		previous_url_secret_expires_at: expect.any(String),
	})
	expect((await owner.list())[0]?.previousUrlActiveUntil).toBe(
		stored?.previous_url_secret_expires_at,
	)
	const overlapUntil = Date.parse(stored!.previous_url_secret_expires_at)
	const overlapExpected = Date.now() + 24 * 60 * 60 * 1000
	expect(overlapUntil).toBeGreaterThan(overlapExpected - 10_000)
	expect(overlapUntil).toBeLessThan(overlapExpected + 10_000)

	const disabled = await setWebhookEnabledForUser({
		env,
		request: sessionRequestContext(userId),
		userId: ownerIdFromStored(userId),
		...sentryHook,
		enabled: false,
	})
	expect(disabled.enabled).toBe(false)
	const rotatedWhileDisabled = await owner.rotate()
	expect(rotatedWhileDisabled.enabled).toBe(false)

	const reminted = await owner.mint()
	expect(reminted.enabled).toBe(true)
	expect(reminted.handle).toBe(rotatedWhileDisabled.handle)
	expect(reminted).not.toHaveProperty('urlSecret')
})

test('clearing rotate overlap ignores a stale current-hash snapshot', async () => {
	const owner = await setupOwner('overlap-race@example.com', 'racer')
	const { db, userId } = owner
	type Hashes = {
		url_secret_hash: string
		previous_url_secret_hash: string | null
		previous_url_secret_expires_at: string | null
	}
	const endpointId = parseWebhookUrlHandle((await owner.mint()).handle)!
	const readHashes = () =>
		owner.readEndpoint<Hashes>(
			endpointId,
			'url_secret_hash, previous_url_secret_hash, previous_url_secret_expires_at',
		)
	const clearFor = (urlSecretHash: string) =>
		webhookRepo.clearWebhookEndpointPreviousUrlSecret({
			db,
			userId,
			endpointId,
			urlSecretHash,
		})

	await owner.rotate()
	const afterFirstRotate = (await readHashes())!
	expect(afterFirstRotate.previous_url_secret_hash).toBeTruthy()

	await owner.rotate()
	const afterSecondRotate = (await readHashes())!
	expect(afterSecondRotate.url_secret_hash).not.toBe(
		afterFirstRotate.url_secret_hash,
	)
	expect(afterSecondRotate.previous_url_secret_hash).toBe(
		afterFirstRotate.url_secret_hash,
	)

	await clearFor(afterFirstRotate.url_secret_hash)
	expect(await readHashes()).toEqual(afterSecondRotate)

	await clearFor(afterSecondRotate.url_secret_hash)
	expect(await readHashes()).toMatchObject({
		previous_url_secret_hash: null,
		previous_url_secret_expires_at: null,
	})
})

test('first mint that loses the id race retries with the persisted endpoint id', async () => {
	const userId = testStableUserIdFromEmail('race@example.com')
	const { env, db, sqlite } = createEnv()
	await provisionPersonalOrgForSqliteUser(sqlite, {
		stableUserId: userId,
		username: 'racer',
	})
	const winnerId = '11111111-1111-1111-1111-111111111111'
	await db
		.prepare(
			`INSERT INTO webhook_endpoints (
				id, user_id, package_id, webhook_name, url_secret_hash,
				url_secret_encrypted, enabled, created_at, rotated_at
			) VALUES (?, ?, 'pkg-1', 'sentry', 'stale-hash', 'stale-ciphertext', 1, ?, ?)`,
		)
		.bind(
			winnerId,
			userId,
			'2026-09-01T00:00:00.000Z',
			'2026-09-01T00:00:00.000Z',
		)
		.run()

	const raceError = await webhookRepo
		.upsertWebhookEndpointSecret({
			db,
			id: '22222222-2222-2222-2222-222222222222',
			userId,
			packageId: 'pkg-1',
			webhookName: 'sentry',
			urlSecretHash: 'unused-hash',
			urlSecretEncrypted: 'unused-ciphertext',
		})
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(raceError).toBeInstanceOf(WebhookEndpointIdRaceError)
	expect((raceError as WebhookEndpointIdRaceError).existingId).toBe(winnerId)

	const getByKey = vi.spyOn(webhookRepo, 'getWebhookEndpointByKey')
	const upsert = vi.spyOn(webhookRepo, 'upsertWebhookEndpointSecret')
	getByKey.mockImplementationOnce(async () => null)

	const minted = await mintWebhookUrlForUser({
		env,
		request: sessionRequestContext(userId),
		userId: ownerIdFromStored(userId),
		email: 'race@example.com',
		username: 'racer',
		...sentryHook,
	})

	expect(upsert).toHaveBeenCalledTimes(2)
	expect(parseWebhookUrlHandle(minted.handle)).toBe(winnerId)
	expect(minted.handle).toBe(`whh_${winnerId}`)

	const stored = await db
		.prepare(
			`SELECT url_secret_hash, url_secret_encrypted FROM webhook_endpoints
			WHERE user_id = ? AND id = ?`,
		)
		.bind(userId, winnerId)
		.first<{ url_secret_hash: string; url_secret_encrypted: string }>()
	expect(stored?.url_secret_encrypted).toBeTruthy()
	expect(stored?.url_secret_encrypted).not.toBe('stale-ciphertext')
	const mintedSecret = await decryptWebhookUrlSecret(
		env,
		stored!.url_secret_encrypted,
		userWebhookUrlSecretContext(ownerIdFromStored(userId), winnerId),
	)
	expect(stored?.url_secret_hash).toBe(await hashWebhookUrlSecret(mintedSecret))

	getByKey.mockRestore()
	upsert.mockRestore()
})

test('concurrent first mints converge on one handle', async () => {
	const userId = testStableUserIdFromEmail('parallel@example.com')
	const { env, sqlite } = createEnv()
	await provisionPersonalOrgForSqliteUser(sqlite, {
		stableUserId: userId,
		username: 'parallel',
	})
	const mint = () =>
		mintWebhookUrlForUser({
			env,
			request: sessionRequestContext(userId),
			userId: ownerIdFromStored(userId),
			username: 'parallel',
			...sentryHook,
		})
	const [first, second] = await Promise.all([mint(), mint()])
	expect(first.handle).toBe(second.handle)
	expect(first.urlHost).toBe('heykody.dev')
	expect(second).not.toHaveProperty('url')
})

test.each([
	{ label: 'no verification', handle: 'signer', verification: {} },
	{
		label: 'url-secret verification',
		handle: 'url-signer',
		verification: { verification: { type: 'url-secret' } },
	},
])(
	'an unsigned webhook ($label) keeps a stored signing secret that reveal does not expose',
	async ({ handle, verification }) => {
		const owner = await setupOwner(`${handle}@example.com`, handle)
		const { env, userId } = owner
		const sentryManifest = vi
			.mocked(loadPackageManifestBySourceId)
			.getMockImplementation()!
		const unsignedManifest = async () => ({
			manifest: {
				name: '@owner/sentry-bridge',
				exports: {
					'./handle-sentry-webhook': './src/handle-sentry-webhook.ts',
				},
				kody: {
					id: 'sentry-bridge',
					description: 'Sentry bridge',
					webhooks: [
						{
							name: 'sentry',
							export: './handle-sentry-webhook',
							responseMode: 'ack',
							...verification,
						},
					],
				},
			},
		})
		vi.mocked(loadPackageManifestBySourceId).mockImplementation(
			unsignedManifest as never,
		)
		const reveal = () =>
			revealWebhookUrlForWebsite({
				env,
				userId: ownerIdFromStored(userId),
				username: handle,
				target: sentryHook,
			})
		try {
			const minted = await owner.mint()
			const endpointId = parseWebhookUrlHandle(minted.handle)!
			const stored = await owner.readEndpoint<{
				hmac_secret_encrypted: string | null
			}>(endpointId, 'hmac_secret_encrypted')
			expect(stored?.hmac_secret_encrypted).toBeTruthy()
			expect(await reveal()).not.toHaveProperty('signingSecret')
			await owner.rotate()
			expect(await reveal()).not.toHaveProperty('signingSecret')
		} finally {
			vi.mocked(loadPackageManifestBySourceId).mockImplementation(
				sentryManifest,
			)
		}
	},
)

test('createInstance mints a second URL under the same declared webhook name', async () => {
	const owner = await setupOwner('multi@example.com', 'multi')
	const { env, userId } = owner
	const request = sessionRequestContext(userId, 'multi')
	const first = await mintWebhookUrlForUser({
		env,
		request,
		userId: ownerIdFromStored(userId),
		email: 'multi@example.com',
		username: 'multi',
		...sentryHook,
	})
	const second = await mintWebhookUrlForUser({
		env,
		request,
		userId: ownerIdFromStored(userId),
		email: 'multi@example.com',
		username: 'multi',
		...sentryHook,
		createInstance: true,
		instanceLabel: 'staging',
	})
	expect(second.handle).not.toBe(first.handle)
	expect(second.endpointId).not.toBe(first.endpointId)
	expect(second.instanceLabel).toBe('staging')
	expect(second.approvalUrl).toContain(
		`enable=webhook%3Asentry%3A${second.endpointId}`,
	)
	expect(second.approvalUrl).not.toContain(first.endpointId)
	const listNow = () =>
		listWebhooksForUser({
			env,
			request,
			baseUrl: 'https://heykody.dev',
			userId: ownerIdFromStored(userId),
		})
	const listed = await listNow()
	const sentry = listed.filter((row) => row.name === 'sentry')
	expect(sentry).toHaveLength(2)
	expect(sentry.map((row) => row.instanceLabel).sort()).toEqual([
		null,
		'staging',
	])
	expect(sentry.every((row) => row.minted)).toBe(true)
	const stagingRow = sentry.find((row) => row.instanceLabel === 'staging')
	expect(stagingRow?.approved).toBe(false)
	expect(stagingRow?.approvalUrl).toContain(
		`enable=webhook%3Asentry%3A${second.endpointId}`,
	)
	expect(stagingRow?.approvalUrl).not.toContain(first.endpointId)
	await setWebhookEnabledForUser({
		env,
		request,
		userId: ownerIdFromStored(userId),
		...sentryHook,
		endpointId: second.endpointId,
		enabled: false,
	})
	const afterDisable = await listNow()
	const staging = afterDisable.find(
		(row) => row.name === 'sentry' && row.instanceLabel === 'staging',
	)
	const primary = afterDisable.find(
		(row) => row.name === 'sentry' && row.instanceLabel === null,
	)
	expect(staging?.enabled).toBe(false)
	expect(primary?.enabled).toBe(true)
})
