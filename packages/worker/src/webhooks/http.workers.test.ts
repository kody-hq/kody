import { env } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test, vi } from 'vitest'
import { checkRateLimit } from '#app/rate-limit.ts'
import { type PackageInvocationRequest } from '#worker/package-invocations/common.ts'
import {
	createRequestHash,
	resolveExistingInvocation,
	type ResolvableInvocationRecord,
} from '#worker/package-invocations/idempotency.ts'
import type * as PackageInvocationServiceModule from '#worker/package-invocations/service.ts'
import { type PackageWebhookManifestEntry } from '#worker/package-registry/manifest.ts'
import { clearRunRecords, listRunRecords } from '#worker/run-records/service.ts'
import {
	buildWebhookTimestampBodyPayload,
	computeWebhookHmacSignature,
	hashWebhookUrlSecret,
} from './crypto.ts'
import type * as DispatchQueueProducerModule from './dispatch-queue-producer.ts'
import { retirePackageSlug } from '#worker/community/package-url.ts'
import { handleWebhookIngressRequest } from './http.ts'
import {
	disableEnablement,
	insertEnablement,
	pauseEnablement,
	resumeEnablement,
} from '#worker/enablements/repo.ts'
import { encryptWebhookVerificationSnapshot } from './hmac-rotation.ts'
import { mintPackageOwnedWebhookHmacCiphertext } from './signing-secret.ts'
import {
	webhookHmacSecretRotationGraceMs,
	webhookRateLimitConfig,
} from './types.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureSavedPackageInternetVisibleColumn } from '#worker/package-registry/internet-visible-column-test-schema.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'
import { consoleInfo, consoleWarn } from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const mocks = vi.hoisted(() => ({
	enqueueWebhookDispatch: vi.fn(),
	invokePackageExport: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	resolveSecret: vi.fn(),
}))

vi.mock('#worker/package-invocations/service.ts', async () => {
	const actual = await vi.importActual<typeof PackageInvocationServiceModule>(
		'#worker/package-invocations/service.ts',
	)
	return {
		...actual,
		invokePackageExport: (...args: Array<unknown>) =>
			mocks.invokePackageExport(...args),
	}
})

vi.mock('#worker/package-registry/source.ts', async () => {
	const { createSubscriptionDiscoverySourceMocks } =
		await import('#worker/test-support/package-subscription-source-mocks.ts')
	return createSubscriptionDiscoverySourceMocks(
		mocks.loadPackageManifestBySourceId,
	)
})

vi.mock('#mcp/secrets/service.ts', () => ({
	resolveSecret: (...args: Array<unknown>) => mocks.resolveSecret(...args),
	findSecretForUse: async (input: unknown) => {
		const resolved = await mocks.resolveSecret(input)
		const { value: _value, ...found } = resolved
		return { found, readValue: async () => resolved }
	},
}))

// Assert the strict rule regardless of the #4129 safety-window flag.
vi.mock('#worker/credentials/allowed-packages-safety-window.ts', async () => {
	const actual = await vi.importActual<
		typeof import('#worker/credentials/allowed-packages-safety-window.ts')
	>('#worker/credentials/allowed-packages-safety-window.ts')
	return { ...actual, tryAllowedPackagesSafetyWindowGrant: async () => false }
})

vi.mock('./dispatch-queue-producer.ts', async () => {
	const actual = await vi.importActual<typeof DispatchQueueProducerModule>(
		'./dispatch-queue-producer.ts',
	)
	return {
		...actual,
		enqueueWebhookDispatch: (...args: Array<unknown>) =>
			mocks.enqueueWebhookDispatch(...args),
	}
})

const handledResponse = {
	status: 200,
	body: { ok: true, result: { handled: true } },
}

function createHashedIdempotencyExportMock() {
	const ledger = new Map<string, ResolvableInvocationRecord>()
	let exportInvocations = 0
	const implementation = async (input: {
		request: PackageInvocationRequest
	}) => {
		const key = input.request.idempotencyKey
		if (!key) {
			exportInvocations += 1
			return handledResponse
		}
		const ignoreParams = input.request.idempotencyParamsHash === 'ignore'
		const requestHash = await createRequestHash({
			packageId: input.request.packageIdOrKodyId,
			exportName: input.request.exportName,
			params: ignoreParams ? undefined : input.request.params,
			source: input.request.source ?? null,
			topic: input.request.topic ?? null,
		})
		const existing = ledger.get(key)
		if (existing) {
			return resolveExistingInvocation({
				record: existing,
				requestHash,
				idempotencyKey: key,
				paramsHash: ignoreParams ? 'ignore' : 'include',
			})
		}
		exportInvocations += 1
		ledger.set(key, {
			requestHash,
			status: 'completed',
			storedResponse: handledResponse,
		})
		return handledResponse
	}
	mocks.invokePackageExport.mockImplementation(implementation)
	return {
		get exportInvocations() {
			return exportInvocations
		},
	}
}

async function ensureSchema(db: D1Database) {
	await ensureUsersTestSchema({ db })
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS saved_packages (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				name TEXT NOT NULL,
				kody_id TEXT NOT NULL,
				description TEXT NOT NULL,
				tags_json TEXT NOT NULL DEFAULT '[]',
				search_text TEXT,
				source_id TEXT NOT NULL,
				has_app INTEGER NOT NULL DEFAULT 0,
				has_skills INTEGER NOT NULL DEFAULT 0,
				hidden INTEGER NOT NULL DEFAULT 0,
				is_private INTEGER NOT NULL DEFAULT 1,
				is_internet_visible INTEGER NOT NULL DEFAULT 0,
				locked_at TEXT,
				deleted_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await ensureSavedPackageInternetVisibleColumn(db)
	for (const [table, slugColumn] of [
		['package_slug_redirects', 'old_slug'],
		['package_kody_id_redirects', 'old_kody_id'],
	] as const) {
		await db
			.prepare(
				`CREATE TABLE IF NOT EXISTS ${table} (
					user_id TEXT NOT NULL,
					${slugColumn} TEXT NOT NULL,
					package_id TEXT NOT NULL,
					created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
					PRIMARY KEY (user_id, ${slugColumn})
				)`,
			)
			.run()
	}
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS webhook_endpoints (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				package_id TEXT NOT NULL,
				webhook_name TEXT NOT NULL,
				url_secret_hash TEXT NOT NULL,
				url_secret_encrypted TEXT,
				hmac_secret_encrypted TEXT,
				hmac_secret_name TEXT,
				hmac_verification_secret_encrypted TEXT,
				previous_url_secret_hash TEXT,
				previous_url_secret_expires_at TEXT,
				previous_hmac_secret_name TEXT,
				previous_hmac_secret_encrypted TEXT,
				previous_hmac_secret_expires_at TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				deleted_at TEXT,
				instance_label TEXT,
				created_at TEXT NOT NULL,
				rotated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS community_forks (
				id TEXT PRIMARY KEY NOT NULL,
				listing_id TEXT, upstream_owner_id TEXT, upstream_package_id TEXT,
				forker_user_id TEXT NOT NULL,
				origin_commit TEXT NOT NULL,
				forked_package_id TEXT NOT NULL,
				forked_source_id TEXT NOT NULL,
				target_kody_id TEXT NOT NULL,
				listing_name TEXT,
				listing_kody_id TEXT,
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				adopted_at TEXT,
				adoption_note TEXT,
				actor TEXT
			)`,
		)
		.run()
	await ensureSoftDeleteTestColumns(db)
}

const urlSecret = 'url-secret-plain'
const hmacSecret = 'hmac-shared-secret'
const githubVerification = {
	type: 'hmac-sha256',
	header: 'x-hub-signature-256',
	secretName: 'githubWebhookSecret',
	encoding: 'hex',
	prefix: 'sha256=',
} as const

/** Default signing secret of each minted endpoint, by webhook name. */
const defaultSigningSecrets = new Map<string, string>()

/** Mints an endpoint with its default signing secret, turned on by its owner. */
async function mintWebhook(input: {
	userId: string
	webhookName: string
	urlSecret?: string
	enablementState?: 'on' | 'off'
	previousUrlSecret?: string
	previousExpiresAt?: string
}) {
	const now = '2026-07-24T00:00:00.000Z'
	const orgId = ownerIdFromStored(input.userId)
	const endpointId = `mint-${input.webhookName}`
	const signingSecret = await mintPackageOwnedWebhookHmacCiphertext({
		env,
		userId: orgId,
		endpointId,
	})
	defaultSigningSecrets.set(input.webhookName, signingSecret.plaintext)
	await env.APP_DB.prepare(
		`INSERT INTO webhook_endpoints (
			id, user_id, package_id, webhook_name, url_secret_hash,
			hmac_secret_encrypted, previous_url_secret_hash,
			previous_url_secret_expires_at, created_at, rotated_at
		) VALUES (?, ?, 'pkg-1', ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			endpointId,
			input.userId,
			input.webhookName,
			await hashWebhookUrlSecret(input.urlSecret ?? urlSecret),
			signingSecret.encrypted,
			input.previousUrlSecret
				? await hashWebhookUrlSecret(input.previousUrlSecret)
				: null,
			input.previousExpiresAt ?? null,
			now,
			now,
		)
		.run()
	const enablement = await insertEnablement({
		db: env.APP_DB,
		enablement: {
			orgId,
			packageId: 'pkg-1',
			triggerKind: 'webhook',
			triggerName: input.webhookName,
			instanceId: endpointId,
			enablerUserId: input.userId,
			origin: 'enabled',
		},
	})
	if (input.enablementState === 'off') {
		await disableEnablement({
			db: env.APP_DB,
			orgId,
			id: enablement.id,
		})
	}
	return enablement
}

async function setupOwnerWithWebhooks(webhookNames: Array<string>) {
	await ensureSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	for (const table of [
		'webhook_endpoints',
		'saved_packages',
		'users',
		'handles',
		'org_memberships',
		'orgs',
		'package_slug_redirects',
		'package_kody_id_redirects',
		'enablements',
		'community_forks',
	]) {
		await env.APP_DB.prepare(`DELETE FROM ${table}`).run()
	}
	const userId = testStableUserIdFromEmail('alice@example.com')
	await env.APP_DB.prepare(
		`INSERT OR REPLACE INTO users (username, email, password_hash, stable_user_id)
		VALUES ('alice', 'alice@example.com', 'hash', ?)`,
	)
		.bind(userId)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId: userId,
		username: 'alice',
		plan: 'max',
	})
	await env.APP_DB.prepare(
		`INSERT OR REPLACE INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, source_id,
			has_app, hidden, is_private, created_at, updated_at
		) VALUES (
			'pkg-1', ?, '@alice/sentry-bridge', 'sentry-bridge', 'Sentry bridge',
			'[]', 'src-1', 0, 0, 1, '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z'
		)`,
	)
		.bind(userId)
		.run()
	await clearRunRecords({ env, userId: ownerIdFromStored(userId) })
	for (const webhookName of webhookNames) {
		await mintWebhook({ userId, webhookName })
	}
	mocks.enqueueWebhookDispatch.mockResolvedValue(undefined)
	mocks.invokePackageExport.mockResolvedValue(handledResponse)
	return userId
}

/** Leaves the manifest's named secret as the only signing secret. */
async function useNamedSecret(webhookName: string) {
	defaultSigningSecrets.delete(webhookName)
	await env.APP_DB.prepare(
		`UPDATE webhook_endpoints SET hmac_secret_encrypted = NULL WHERE id = ?`,
	)
		.bind(`mint-${webhookName}`)
		.run()
}

async function enablementIdOf(webhookName: string) {
	const row = await env.APP_DB.prepare(
		`SELECT id FROM enablements WHERE instance_id = ?`,
	)
		.bind(`mint-${webhookName}`)
		.first<{ id: string }>()
	if (!row) throw new Error(`No enablement for ${webhookName}.`)
	return row.id
}

function suspendOwner(userId: string, at: string) {
	return env.APP_DB.prepare(
		`UPDATE users SET suspended_at = ? WHERE stable_user_id = ?`,
	)
		.bind(at, userId)
		.run()
}

const secretLookup = (value: string | null) => ({
	found: value !== null,
	value,
	scope: value === null ? null : 'user',
	allowedHosts: [],
	allowedPackages: [],
})

function mockSecretValue(value: string | null) {
	mocks.resolveSecret.mockResolvedValue(secretLookup(value))
}

type WebhookDeclaration = { name: string } & {
	[
		K in
			| 'responseMode'
			| 'inputMode'
			| 'rateLimitPerMinute'
			| 'verification'
			| 'replay'
			| 'challenge'
	]?: NonNullable<PackageWebhookManifestEntry[K]>
}

function declareWebhook(input: WebhookDeclaration) {
	mocks.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: {
			name: '@alice/sentry-bridge',
			exports: {
				'./handle-sentry-webhook': './src/handle-sentry-webhook.ts',
			},
			kody: {
				id: 'sentry-bridge',
				description: 'Sentry bridge',
				webhooks: [
					{
						export: './handle-sentry-webhook',
						responseMode: 'ack',
						...input,
					},
				],
			},
		},
	})
}

function encodeBytes(bytes: Uint8Array) {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer
}

function encodeBody(text: string) {
	return encodeBytes(new TextEncoder().encode(text))
}

function sign(
	body: string | ArrayBuffer,
	prefix: string | null = 'sha256=',
	secret = hmacSecret,
) {
	return computeWebhookHmacSignature({
		algorithm: 'hmac-sha256',
		secret,
		body: typeof body === 'string' ? encodeBody(body) : body,
		encoding: 'hex',
		prefix: prefix ?? undefined,
	})
}

async function sendWebhook(
	webhookName: string,
	init: {
		packageSlug?: string
		method?: 'GET' | 'POST'
		query?: string
		urlSecret?: string
		body?: string | Uint8Array
		headers?: Record<string, string>
		/** Skips the endpoint's default `x-kody-signature`. */
		unsigned?: true
	} = {},
) {
	const method = init.method ?? 'POST'
	const body = init.body ?? JSON.stringify({ hello: 'world' })
	const signingSecret = defaultSigningSecrets.get(webhookName)
	const headers = { ...init.headers }
	if (
		method === 'POST' &&
		signingSecret &&
		!init.unsigned &&
		!('x-kody-signature' in headers)
	) {
		headers['x-kody-signature'] = await sign(
			typeof body === 'string' ? body : encodeBytes(body),
			'sha256=',
			signingSecret,
		)
	}
	const ctx = createExecutionContext()
	const response = await handleWebhookIngressRequest(
		new Request(
			`https://test.kody.dev/@alice/webhooks/${init.packageSlug ?? 'sentry-bridge'}/${webhookName}/${init.urlSecret ?? urlSecret}${init.query ? `?${init.query}` : ''}`,
			method === 'GET'
				? { method }
				: {
						method,
						headers: { 'content-type': 'application/json', ...headers },
						body: body as BodyInit,
					},
		),
		env,
		ctx,
	)
	await waitOnExecutionContext(ctx)
	return response
}

async function statusOf(...args: Parameters<typeof sendWebhook>) {
	return (await sendWebhook(...args)).status
}

type EnqueuedMessage = {
	deliveryId: string
	endpoint: { userId: string }
	payloadKvKey?: string
	callerIdempotency?: true
	params: {
		webhook: { packageKodyId: string; name: string }
		request: { body: string; json: unknown }
	}
}

type InvokedRequest = {
	params: Record<string, unknown> & {
		webhook: { name: string; receivedAt: string }
		request: { json: unknown }
	}
	idempotencyKey: string
	idempotencyParamsHash?: 'ignore'
	idempotencyHashParams?: Record<string, unknown>
}

const enqueued = (index: number): EnqueuedMessage =>
	mocks.enqueueWebhookDispatch.mock.calls[index]![0].message
const invoked = (index: number): InvokedRequest =>
	mocks.invokePackageExport.mock.calls.at(index)![0].request

async function listDeliveries(userId: string, webhookName: string) {
	const page = await listRunRecords({
		env,
		userId: ownerIdFromStored(userId),
		filter: { surface: 'webhook' },
		limit: 100,
	})
	return page.runs.filter((run) => run.name === webhookName)
}

test('package-centered webhook ingress auth, HMAC, size cap, ack/sync, and isolation', async () => {
	const userId = await setupOwnerWithWebhooks(['sentry', 'sync-hook'])
	await mintWebhook({
		userId,
		webhookName: 'disabled',
		enablementState: 'off',
	})
	await useNamedSecret('sentry')
	declareWebhook({ name: 'sentry', verification: githubVerification })
	mockSecretValue(hmacSecret)

	const body = JSON.stringify({ event: 'push' })
	const signature = await sign(body)
	const signed = { body, headers: { 'x-hub-signature-256': signature } }

	expect(await statusOf('sentry', signed)).toBe(202)
	expect(mocks.invokePackageExport).not.toHaveBeenCalled()
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(1)
	expect(enqueued(0).endpoint.userId).toBe(userId)
	expect(enqueued(0).params.webhook).toEqual({
		packageKodyId: 'sentry-bridge',
		name: 'sentry',
		receivedAt: expect.any(String),
	})
	expect(enqueued(0).params.request.json).toBeNull()
	expect(enqueued(0).params.request.body).toBe(body)
	expect(enqueued(0).payloadKvKey).toBeUndefined()

	const signedBody = async (text: string) => ({
		body: text,
		headers: { 'x-hub-signature-256': await sign(text) },
	})
	const midSizeBody = JSON.stringify({ payload: 'x'.repeat(70_000) })
	expect(await statusOf('sentry', await signedBody(midSizeBody))).toBe(202)
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(2)
	expect(enqueued(1).payloadKvKey).toBeUndefined()
	expect(enqueued(1).params.request.json).toBeNull()

	const largeBody = JSON.stringify({ payload: 'y'.repeat(140_000) })
	expect(await statusOf('sentry', await signedBody(largeBody))).toBe(202)
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(3)
	const large = enqueued(2)
	expect(large.params.request.body).toBe('')
	expect(large.params.request.json).toBeNull()
	expect(large.payloadKvKey).toBe(
		`webhook-dispatch-payload:v1:${large.endpoint.userId}:${large.deliveryId}`,
	)
	expect(await env.BUNDLE_ARTIFACTS_KV.get(large.payloadKvKey!)).toBe(largeBody)

	declareWebhook({ name: 'sync-hook', responseMode: 'sync' })
	const sync = await sendWebhook('sync-hook', {
		body: JSON.stringify({ sync: true }),
	})
	expect(sync.status).toBe(200)
	await expect(sync.json()).resolves.toEqual({
		ok: true,
		result: { handled: true },
	})
	expect((await listDeliveries(userId, 'sync-hook'))[0]?.status).toBe('success')

	expect(await statusOf('sentry', { urlSecret: 'wrong' })).toBe(404)
	expect(await statusOf('disabled')).toBe(404)
	expect(await listDeliveries(userId, 'disabled')).toEqual([])
	expect(await statusOf('never-minted')).toBe(404)

	declareWebhook({ name: 'sentry', verification: githubVerification })
	expect(
		await statusOf('sentry', {
			body,
			headers: { 'x-hub-signature-256': 'sha256=00' },
		}),
	).toBe(401)

	mocks.resolveSecret.mockResolvedValueOnce(secretLookup(null))
	expect(await statusOf('sentry', signed)).toBe(401)
	expect(
		(await listDeliveries(userId, 'sentry')).some(
			(run) =>
				run.status === 'error' &&
				typeof run.errorMessage === 'string' &&
				run.errorMessage.startsWith('verification_secret_missing:'),
		),
	).toBe(true)

	// Removed from manifest → 404
	mocks.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: {
			name: '@alice/sentry-bridge',
			exports: { '.': './index.ts' },
			kody: { id: 'sentry-bridge', description: 'Sentry bridge' },
		},
	})
	expect(await statusOf('sentry')).toBe(404)
})

test('a webhook cannot verify with a secret its package may not read (#3245)', async () => {
	const userId = await setupOwnerWithWebhooks(['sentry'])
	await useNamedSecret('sentry')
	declareWebhook({ name: 'sentry', verification: githubVerification })
	mocks.resolveSecret.mockResolvedValue({
		...secretLookup(hmacSecret),
		allowedPackages: ['pkg-other'],
	})
	await env.APP_DB.prepare(
		`INSERT INTO community_forks (
			id, listing_id, forker_user_id, origin_commit, forked_package_id,
			forked_source_id, target_kody_id
		) VALUES ('fork-1', 'listing-1', ?, 'origin', 'pkg-1', 'src-1', 'sentry-bridge')`,
	)
		.bind(userId)
		.run()
	const body = JSON.stringify({ event: 'push' })
	const signed = {
		body,
		headers: { 'x-hub-signature-256': await sign(body) },
	}

	consoleWarn.mockImplementation(() => {})
	expect(await statusOf('sentry', signed)).toBe(401)
	expect(mocks.enqueueWebhookDispatch).not.toHaveBeenCalled()
	expect(mocks.invokePackageExport).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		'webhook-declared-secret-resolve-failed',
		expect.objectContaining({ secretName: 'githubWebhookSecret' }),
	)

	await env.APP_DB.prepare(
		`UPDATE community_forks SET adopted_at = ? WHERE id = 'fork-1'`,
	)
		.bind(new Date().toISOString())
		.run()
	expect(await statusOf('sentry', signed)).toBe(401)
	expect(mocks.enqueueWebhookDispatch).not.toHaveBeenCalled()

	mocks.resolveSecret.mockResolvedValue({
		...secretLookup(hmacSecret),
		allowedPackages: ['pkg-other', 'pkg-1'],
	})
	expect(await statusOf('sentry', signed)).toBe(202)
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(1)
})

test('webhook ingress follows a package slug redirect after a rename', async () => {
	const userId = await setupOwnerWithWebhooks(['sentry'])
	declareWebhook({ name: 'sentry' })
	await env.APP_DB.prepare(
		`UPDATE saved_packages
		SET name = '@alice/error-bridge', kody_id = 'error-bridge'
		WHERE id = 'pkg-1'`,
	).run()

	expect(await statusOf('sentry')).toBe(404)
	await retirePackageSlug({
		db: env.APP_DB,
		userId,
		packageId: 'pkg-1',
		oldSlug: 'sentry-bridge',
		newSlug: 'error-bridge',
	})

	expect(await statusOf('sentry')).toBe(202)
	expect(await statusOf('sentry', { packageSlug: 'error-bridge' })).toBe(202)
	expect(enqueued(0).params.webhook.packageKodyId).toBe('error-bridge')
	expect(await statusOf('sentry', { urlSecret: 'wrong' })).toBe(404)
	expect(await statusOf('sentry', { packageSlug: 'never-existed' })).toBe(404)
})

test('webhook delivery records real startedAt duration and explicit delivered outcome with handler result', async () => {
	const userId = await setupOwnerWithWebhooks(['sync-hook'])
	declareWebhook({ name: 'sync-hook', responseMode: 'sync' })

	vi.useFakeTimers({ shouldAdvanceTime: true })
	let releaseHandler!: () => void
	const handlerGate = new Promise<void>((resolve) => {
		releaseHandler = resolve
	})
	mocks.invokePackageExport.mockImplementation(async () => {
		await handlerGate
		return handledResponse
	})

	const responsePromise = sendWebhook('sync-hook', {
		body: JSON.stringify({ sync: true }),
	})
	await vi.waitFor(() => mocks.invokePackageExport.mock.calls.length === 1)
	await vi.advanceTimersByTimeAsync(25)
	releaseHandler()
	const response = await responsePromise
	vi.useRealTimers()
	expect(response.status).toBe(200)

	const delivered = (await listDeliveries(userId, 'sync-hook'))[0]
	expect(delivered?.status).toBe('success')
	expect(delivered?.startedAt).toBe(invoked(0).params.webhook.receivedAt)
	expect(delivered?.durationMs).toBeGreaterThan(0)
	expect(delivered?.metadata).toMatchObject({
		outcome: 'delivered',
		httpStatus: 200,
		result: { handled: true },
	})
})

test('webhook delivery records explicit rejected and failed outcomes', async () => {
	const userId = await setupOwnerWithWebhooks(['sync-hook'])
	declareWebhook({ name: 'sync-hook', responseMode: 'sync' })
	const findOutcome = async (outcome: string) =>
		(await listDeliveries(userId, 'sync-hook')).find(
			(run) => run.metadata?.['outcome'] === outcome,
		)

	expect(
		await statusOf('sync-hook', {
			body: new Uint8Array(1024 * 1024 + 1),
			headers: { 'content-type': 'application/octet-stream' },
		}),
	).toBe(413)
	expect((await findOutcome('rejected'))?.metadata).toMatchObject({
		outcome: 'rejected',
		httpStatus: 413,
	})

	mocks.invokePackageExport.mockResolvedValue({
		status: 500,
		body: { ok: false },
	})
	expect(
		await statusOf('sync-hook', { body: JSON.stringify({ boom: true }) }),
	).toBe(502)
	const failed = await findOutcome('failed')
	expect(failed?.status).toBe('error')
	expect(failed?.metadata).toMatchObject({
		outcome: 'failed',
		httpStatus: 502,
	})
})

test('a sync webhook whose package was refused for credential placement returns a safe cause', async () => {
	const userId = await setupOwnerWithWebhooks(['sync-hook'])
	declareWebhook({ name: 'sync-hook', responseMode: 'sync' })
	mocks.invokePackageExport.mockResolvedValue({
		status: 500,
		body: {
			ok: false,
			error: {
				code: 'execution_failed',
				message:
					'Error: Secret "clerkReviewUserId" cannot be sent to host "api.example.com" over plain HTTP. The fetch gateway fills secrets only over HTTPS. Use an https:// URL. (credential_placement_refused, slot "clerkReviewUserId")',
				details: { stack: 'at reviewTicket (index.ts:12:3)' },
			},
			logs: ['upstream https://api.clerk.com/v1/users'],
		},
	})

	const response = await sendWebhook('sync-hook', {
		body: JSON.stringify({ ticket: 1 }),
	})
	expect(response.status).toBe(502)
	const body = await response.json()
	expect(body).toEqual({
		ok: false,
		error: {
			code: 'credential_placement_refused',
			message:
				'The package tried to send a credential (slot "clerkReviewUserId") to a host the credential does not allow, over plain HTTP, or in the URL host, so Kody refused the request. The package owner or the credential\'s owner needs to fix it.',
			slot: 'clerkReviewUserId',
		},
	})
	const serialized = JSON.stringify(body)
	expect(serialized).not.toContain('request body')
	expect(serialized).not.toContain('index.ts')
	expect(serialized).not.toContain('api.clerk.com')

	const failed = (await listDeliveries(userId, 'sync-hook')).find(
		(run) => run.metadata?.['outcome'] === 'failed',
	)
	expect(failed?.metadata).toMatchObject({ httpStatus: 502 })
	// The owner's webhook run keeps the stable code first, then the export's
	// own (sanitized) error so Activity says why it failed.
	expect(failed?.errorMessage).toMatch(
		/^credential_placement_refused: Error: Secret "clerkReviewUserId" cannot be sent/,
	)
	// Sync deliveries keep the interactive sandbox budget.
	expect(mocks.invokePackageExport.mock.calls.at(-1)?.[0]).not.toHaveProperty(
		'executorTimeoutMs',
	)
})

test('webhook ingress rejects suspended owners before any dispatch', async () => {
	const userId = await setupOwnerWithWebhooks(['ack-hook', 'sync-hook'])
	await suspendOwner(userId, '2026-09-23T00:00:00.000Z')

	for (const hook of [
		{ name: 'ack-hook', responseMode: 'ack' as const },
		{ name: 'sync-hook', responseMode: 'sync' as const },
	]) {
		declareWebhook(hook)
		const response = await sendWebhook(hook.name)
		expect(response.status).toBe(403)
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			error: { code: 'account_suspended' },
		})
		const deliveries = await listDeliveries(userId, hook.name)
		expect(deliveries[0]?.metadata).toMatchObject({
			outcome: 'rejected',
			httpStatus: 403,
		})
		expect(deliveries[0]?.errorMessage).toBe('account_suspended')
	}
	expect(mocks.invokePackageExport).not.toHaveBeenCalled()
	expect(mocks.enqueueWebhookDispatch).not.toHaveBeenCalled()
})

test('a webhook that declares no verification runs on its URL secret alone, with no signature', async () => {
	const userId = await setupOwnerWithWebhooks(['plain', 'plain-sync'])
	const body = JSON.stringify({ event: 'ping' })

	declareWebhook({ name: 'plain-sync', responseMode: 'sync' })
	const sync = await sendWebhook('plain-sync', { body, unsigned: true })
	expect(sync.status).toBe(200)
	await expect(sync.json()).resolves.toEqual({
		ok: true,
		result: { handled: true },
	})
	expect(mocks.invokePackageExport).toHaveBeenCalledTimes(1)
	expect(invoked(-1).params.request.json).toEqual({ event: 'ping' })
	expect((await listDeliveries(userId, 'plain-sync'))[0]).toMatchObject({
		status: 'success',
	})

	declareWebhook({ name: 'plain' })
	expect(await statusOf('plain', { body, unsigned: true })).toBe(202)
	// A stray signature header is ignored, as it was before signatures existed.
	expect(
		await statusOf('plain', {
			body,
			headers: { 'x-kody-signature': await sign(body, 'sha256=', 'wrong') },
		}),
	).toBe(202)
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(2)
	const urlSecretOnlyLogs = () =>
		consoleInfo.mock.calls.filter(
			([message]) => message === 'webhook-url-secret-only-authenticated',
		)
	expect(urlSecretOnlyLogs()).toHaveLength(3)
	expect(urlSecretOnlyLogs()[2]?.[1]).toMatchObject({
		endpointId: 'mint-plain',
		webhookName: 'plain',
	})

	expect(
		await statusOf('plain', { body, unsigned: true, urlSecret: 'wrong' }),
	).toBe(404)
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(2)
	expect(urlSecretOnlyLogs()).toHaveLength(3)
	expect(
		(await listDeliveries(userId, 'plain')).filter(
			(run) => run.status === 'error',
		),
	).toEqual([])
})

test('explicit url-secret verification runs on the URL secret; a declared HMAC scheme never falls back to it', async () => {
	const userId = await setupOwnerWithWebhooks(['explicit', 'signed'])
	const body = JSON.stringify({ event: 'ping' })

	declareWebhook({ name: 'explicit', verification: { type: 'url-secret' } })
	expect(await statusOf('explicit', { body, unsigned: true })).toBe(202)
	expect(
		await statusOf('explicit', {
			body,
			headers: { 'x-kody-signature': await sign(body, 'sha256=', 'wrong') },
		}),
	).toBe(202)
	expect(
		await statusOf('explicit', { body, unsigned: true, urlSecret: 'wrong' }),
	).toBe(404)
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(2)
	expect(
		consoleInfo.mock.calls.filter(
			([message]) => message === 'webhook-url-secret-only-authenticated',
		),
	).toEqual([])

	declareWebhook({
		name: 'signed',
		verification: {
			type: 'hmac-sha256',
			header: 'x-kody-signature',
			encoding: 'hex',
			prefix: 'sha256=',
		},
	})
	const unsigned = await sendWebhook('signed', { body, unsigned: true })
	expect(unsigned.status).toBe(401)
	expect(
		await statusOf('signed', {
			body,
			headers: { 'x-kody-signature': await sign(body, 'sha256=', 'wrong') },
		}),
	).toBe(401)
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(2)
	expect(
		(await listDeliveries(userId, 'signed')).map((run) => run.errorMessage),
	).toEqual(expect.arrayContaining(['missing_signature', 'invalid_signature']))
	expect(await statusOf('signed', { body })).toBe(202)
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(3)
})

test('live undeclared webhooks (telegram-trigger telegram, feature-planner upload) keep delivering unchanged', async () => {
	const userId = await setupOwnerWithWebhooks(['telegram', 'upload'])
	const telegramUpdate = JSON.stringify({
		update_id: 1,
		message: { chat: { id: 7 }, text: '/start' },
	})
	// Telegram sends its own secret-token header and never signs the body.
	const telegramHeaders = {
		'content-type': 'application/json',
		'x-telegram-bot-api-secret-token': 'owner-chosen-token',
	}

	declareWebhook({ name: 'telegram' })
	expect(
		await statusOf('telegram', {
			body: telegramUpdate,
			headers: telegramHeaders,
			unsigned: true,
		}),
	).toBe(202)
	expect(enqueued(0).params.webhook.name).toBe('telegram')
	expect(enqueued(0).params.request.body).toBe(telegramUpdate)

	declareWebhook({
		name: 'upload',
		responseMode: 'sync',
		inputMode: 'request',
	})
	const upload = await sendWebhook('upload', {
		body: 'title=Plan&notes=ship+it',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		unsigned: true,
	})
	expect(upload.status).toBe(200)
	await expect(upload.json()).resolves.toEqual({
		ok: true,
		result: { handled: true },
	})
	expect(mocks.invokePackageExport).toHaveBeenCalledTimes(1)

	expect(
		(await listDeliveries(userId, 'telegram')).map((run) => run.errorMessage),
	).not.toContain('missing_signature')
	expect((await listDeliveries(userId, 'upload'))[0]).toMatchObject({
		status: 'success',
	})

	// Declaring a signing scheme on the same URL never falls back to the URL
	// secret, even when the provider's own secret header is present.
	declareWebhook({
		name: 'telegram',
		verification: {
			type: 'hmac-sha256',
			header: 'x-kody-signature',
			encoding: 'hex',
			prefix: 'sha256=',
		},
	})
	expect(
		await statusOf('telegram', {
			body: telegramUpdate,
			headers: telegramHeaders,
			unsigned: true,
		}),
	).toBe(401)
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(1)
})

test('a declared verification.secretName wins over the stored generated secret, on the same URL', async () => {
	const userId = await setupOwnerWithWebhooks(['stripe'])
	const generated = defaultSigningSecrets.get('stripe')!
	defaultSigningSecrets.delete('stripe')
	declareWebhook({
		name: 'stripe',
		verification: {
			type: 'hmac-sha256',
			header: 'stripe-signature',
			secretName: 'stripeWebhookSecretCancelFarewell',
			encoding: 'hex',
			signedPayload: 'timestamp.body',
		},
		replay: {
			timestampHeader: 'Stripe-Signature',
			timestampFormat: 'stripe-signature',
			toleranceSeconds: 300,
		},
	})
	mockSecretValue(hmacSecret)
	const body = JSON.stringify({ type: 'customer.subscription.deleted' })
	const stripeSigned = async (secret: string) => {
		const seconds = Math.floor(Date.now() / 1000)
		const payload = buildWebhookTimestampBodyPayload({
			timestampToken: String(seconds),
			body: encodeBody(body),
		})
		return {
			body,
			headers: {
				'stripe-signature': `t=${seconds},v1=${await sign(payload, null, secret)}`,
			},
		}
	}

	expect(await statusOf('stripe', await stripeSigned(hmacSecret))).toBe(202)
	expect(mocks.resolveSecret).toHaveBeenCalledWith(
		expect.objectContaining({ name: 'stripeWebhookSecretCancelFarewell' }),
	)
	expect(await statusOf('stripe', await stripeSigned('not-the-secret'))).toBe(
		401,
	)

	// Senders already signing with the stored secret keep verifying.
	consoleWarn.mockImplementation(() => {})
	expect(await statusOf('stripe', await stripeSigned(generated))).toBe(202)
	expect(consoleWarn).toHaveBeenCalledWith(
		'webhook-signature-matched-stored-secret-not-declared',
		expect.objectContaining({
			endpointId: 'mint-stripe',
			secretName: 'stripeWebhookSecretCancelFarewell',
		}),
	)
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(2)
	expect(consoleInfo).not.toHaveBeenCalledWith(
		'webhook-url-secret-only-authenticated',
		expect.anything(),
	)

	const endpoint = await env.APP_DB.prepare(
		`SELECT url_secret_hash FROM webhook_endpoints WHERE id = 'mint-stripe'`,
	).first<{ url_secret_hash: string }>()
	expect(endpoint?.url_secret_hash).toBe(await hashWebhookUrlSecret(urlSecret))
	expect(
		(await listDeliveries(userId, 'stripe')).map((run) => run.errorMessage),
	).toEqual(expect.arrayContaining(['invalid_signature']))
})

test('signing-secret rotation grace accepts the previous key for 24h, then rejects it', async () => {
	const userId = await setupOwnerWithWebhooks(['stripe-rotate'])
	await useNamedSecret('stripe-rotate')
	const orgId = ownerIdFromStored(userId)
	const previousSecret = 'stripe-signing-secret-v1'
	const currentSecret = 'stripe-signing-secret-v2'
	const snapshot = await encryptWebhookVerificationSnapshot({
		env,
		userId: orgId,
		endpointId: 'mint-stripe-rotate',
		plaintext: currentSecret,
	})
	const previousEncrypted = await encryptWebhookVerificationSnapshot({
		env,
		userId: orgId,
		endpointId: 'mint-stripe-rotate',
		plaintext: previousSecret,
	})
	const graceUntil = new Date(
		Date.now() + webhookHmacSecretRotationGraceMs,
	).toISOString()
	await env.APP_DB.prepare(
		`UPDATE webhook_endpoints
		 SET hmac_secret_name = ?,
			 hmac_verification_secret_encrypted = ?,
			 previous_hmac_secret_name = ?,
			 previous_hmac_secret_encrypted = ?,
			 previous_hmac_secret_expires_at = ?
		 WHERE id = ?`,
	)
		.bind(
			'stripeWebhookSecret',
			snapshot,
			'stripeWebhookSecret',
			previousEncrypted,
			graceUntil,
			'mint-stripe-rotate',
		)
		.run()
	declareWebhook({
		name: 'stripe-rotate',
		verification: {
			type: 'hmac-sha256',
			header: 'stripe-signature',
			secretName: 'stripeWebhookSecret',
			encoding: 'hex',
			signedPayload: 'timestamp.body',
		},
		replay: {
			timestampHeader: 'Stripe-Signature',
			timestampFormat: 'stripe-signature',
			toleranceSeconds: 300,
		},
	})
	mockSecretValue(currentSecret)
	const body = JSON.stringify({ type: 'invoice.paid' })
	const stripeSigned = async (secret: string) => {
		const seconds = Math.floor(Date.now() / 1000)
		const payload = buildWebhookTimestampBodyPayload({
			timestampToken: String(seconds),
			body: encodeBody(body),
		})
		return {
			body,
			headers: {
				'stripe-signature': `t=${seconds},v1=${await sign(payload, null, secret)}`,
			},
		}
	}

	expect(
		await statusOf('stripe-rotate', await stripeSigned(previousSecret)),
	).toBe(202)
	expect(
		await statusOf('stripe-rotate', await stripeSigned(currentSecret)),
	).toBe(202)
	expect(
		await statusOf(
			'stripe-rotate',
			await stripeSigned('unrelated-other-secret'),
		),
	).toBe(401)

	// Re-seed an already-expired previous after the current-key delivery
	// retired the live grace window early.
	await env.APP_DB.prepare(
		`UPDATE webhook_endpoints
		 SET previous_hmac_secret_name = ?,
			 previous_hmac_secret_encrypted = ?,
			 previous_hmac_secret_expires_at = ?
		 WHERE id = ?`,
	)
		.bind(
			'stripeWebhookSecret',
			previousEncrypted,
			new Date(Date.now() - 1_000).toISOString(),
			'mint-stripe-rotate',
		)
		.run()
	expect(
		await statusOf('stripe-rotate', await stripeSigned(previousSecret)),
	).toBe(401)
	expect(
		await statusOf('stripe-rotate', await stripeSigned(currentSecret)),
	).toBe(202)
})

test('sync rejected dispatch does not retire previous HMAC grace', async () => {
	const userId = await setupOwnerWithWebhooks(['stripe-sync-rotate'])
	await useNamedSecret('stripe-sync-rotate')
	const orgId = ownerIdFromStored(userId)
	const previousSecret = 'stripe-signing-secret-v1'
	const currentSecret = 'stripe-signing-secret-v2'
	const endpointId = 'mint-stripe-sync-rotate'
	const snapshot = await encryptWebhookVerificationSnapshot({
		env,
		userId: orgId,
		endpointId,
		plaintext: currentSecret,
	})
	const previousEncrypted = await encryptWebhookVerificationSnapshot({
		env,
		userId: orgId,
		endpointId,
		plaintext: previousSecret,
	})
	const graceUntil = new Date(
		Date.now() + webhookHmacSecretRotationGraceMs,
	).toISOString()
	await env.APP_DB.prepare(
		`UPDATE webhook_endpoints
		 SET hmac_secret_name = ?,
			 hmac_verification_secret_encrypted = ?,
			 previous_hmac_secret_name = ?,
			 previous_hmac_secret_encrypted = ?,
			 previous_hmac_secret_expires_at = ?
		 WHERE id = ?`,
	)
		.bind(
			'stripeWebhookSecret',
			snapshot,
			'stripeWebhookSecret',
			previousEncrypted,
			graceUntil,
			endpointId,
		)
		.run()
	declareWebhook({
		name: 'stripe-sync-rotate',
		responseMode: 'sync',
		verification: {
			type: 'hmac-sha256',
			header: 'stripe-signature',
			secretName: 'stripeWebhookSecret',
			encoding: 'hex',
			signedPayload: 'timestamp.body',
		},
		replay: {
			timestampHeader: 'Stripe-Signature',
			timestampFormat: 'stripe-signature',
			toleranceSeconds: 300,
		},
	})
	mockSecretValue(currentSecret)
	const body = JSON.stringify({ type: 'invoice.paid' })
	const stripeSigned = async (secret: string) => {
		const seconds = Math.floor(Date.now() / 1000)
		const payload = buildWebhookTimestampBodyPayload({
			timestampToken: String(seconds),
			body: encodeBody(body),
		})
		return {
			body,
			headers: {
				'stripe-signature': `t=${seconds},v1=${await sign(payload, null, secret)}`,
			},
		}
	}

	const enablementId = await enablementIdOf('stripe-sync-rotate')
	const removedAt = new Date().toISOString()
	expect(
		await pauseEnablement({
			db: env.APP_DB,
			orgId,
			id: enablementId,
			pause: { reason: 'org_access' },
		}),
	).toBe(true)
	await env.APP_DB.prepare(
		`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ? AND user_id = ?`,
	)
		.bind(removedAt, orgId, userId)
		.run()
	await env.APP_DB.prepare(
		`UPDATE grants SET deleted_at = ?
		 WHERE org_id = ? AND subject_type = 'user' AND subject_id = ?`,
	)
		.bind(removedAt, orgId, userId)
		.run()
	expect(
		await statusOf('stripe-sync-rotate', await stripeSigned(currentSecret)),
	).toBe(409)
	const afterReject = await env.APP_DB.prepare(
		`SELECT previous_hmac_secret_encrypted, previous_hmac_secret_expires_at
		 FROM webhook_endpoints WHERE id = ?`,
	)
		.bind(endpointId)
		.first<{
			previous_hmac_secret_encrypted: string | null
			previous_hmac_secret_expires_at: string | null
		}>()
	expect(afterReject?.previous_hmac_secret_encrypted).toBe(previousEncrypted)
	expect(afterReject?.previous_hmac_secret_expires_at).toBe(graceUntil)
	const pausedEnablement = await env.APP_DB.prepare(
		`SELECT state FROM enablements WHERE id = ?`,
	)
		.bind(enablementId)
		.first<{ state: string }>()
	expect(pausedEnablement?.state).toBe('paused')

	await env.APP_DB.prepare(
		`UPDATE org_memberships SET deleted_at = NULL WHERE org_id = ? AND user_id = ?`,
	)
		.bind(orgId, userId)
		.run()
	await env.APP_DB.prepare(
		`UPDATE grants SET deleted_at = NULL
		 WHERE org_id = ? AND subject_type = 'user' AND subject_id = ?`,
	)
		.bind(orgId, userId)
		.run()
	expect(
		await resumeEnablement({ db: env.APP_DB, orgId, id: enablementId }),
	).toBe(true)
	expect(
		await statusOf('stripe-sync-rotate', await stripeSigned(previousSecret)),
	).toBe(200)
	expect(
		await statusOf('stripe-sync-rotate', await stripeSigned(currentSecret)),
	).toBe(200)
	const afterSuccess = await env.APP_DB.prepare(
		`SELECT previous_hmac_secret_encrypted FROM webhook_endpoints WHERE id = ?`,
	)
		.bind(endpointId)
		.first<{ previous_hmac_secret_encrypted: string | null }>()
	expect(afterSuccess?.previous_hmac_secret_encrypted).toBeNull()
})

test('a webhook with no enablement on answers 409 instead of running', async () => {
	const userId = await setupOwnerWithWebhooks(['plain'])
	declareWebhook({ name: 'plain' })
	const body = JSON.stringify({ event: 'ping' })

	await env.APP_DB.prepare(`DELETE FROM enablements`).run()
	const off = await sendWebhook('plain', { body, unsigned: true })
	expect(off.status).toBe(409)
	const offBody = (await off.json()) as {
		error: { code: string; message: string; details: { approvalUrl: string } }
	}
	expect(offBody.error.code).toBe('enablement_not_on')
	expect(offBody.error.details.approvalUrl).toMatch(
		/^https?:\/\/[^/]+\/@alice\/sentry-bridge\/approve-credentials\?enable=webhook%3Aplain%3Amint-plain$/,
	)
	expect(offBody.error.message).toBe(
		`Webhook "plain" is not approved, so nothing ran. Minting a URL does not turn a webhook on. Approve it: ${offBody.error.details.approvalUrl}`,
	)

	// Nobody has turned it on: ack mode answers 409 instead of queueing.
	expect(await statusOf('plain', { body, unsigned: true })).toBe(409)
	expect(mocks.enqueueWebhookDispatch).not.toHaveBeenCalled()
	const rejected = (await listDeliveries(userId, 'plain')).filter(
		(run) => run.status === 'error',
	)
	expect(rejected.map((run) => run.errorMessage)).toEqual([
		'enablement_not_on',
		'enablement_not_on',
	])
})

test('opt-in webhook replay protection rejects stale timestamps and dedupes delivery ids', async () => {
	await setupOwnerWithWebhooks(['stripe', 'github', 'unix'])
	await useNamedSecret('stripe')
	await useNamedSecret('github')
	mockSecretValue(hmacSecret)

	const body = JSON.stringify({ event: 'invoice.paid' })
	const nowSeconds = Math.floor(Date.now() / 1000)
	const stripeHeader = async (seconds: number) => {
		const payload = buildWebhookTimestampBodyPayload({
			timestampToken: String(seconds),
			body: encodeBody(body),
		})
		return {
			'stripe-signature': `t=${seconds},v1=${await sign(payload, null)}`,
		}
	}

	declareWebhook({
		name: 'stripe',
		verification: {
			type: 'hmac-sha256',
			header: 'stripe-signature',
			secretName: 'stripeWebhookSecret',
			encoding: 'hex',
			signedPayload: 'timestamp.body',
		},
		replay: {
			timestampHeader: 'Stripe-Signature',
			timestampFormat: 'stripe-signature',
			toleranceSeconds: 300,
		},
	})

	const acceptedStripe = await sendWebhook('stripe', {
		body,
		headers: await stripeHeader(nowSeconds),
	})
	expect(acceptedStripe.status).toBe(202)
	expect(await acceptedStripe.json()).toEqual({ ok: true })

	const staleStripe = await sendWebhook('stripe', {
		body,
		headers: await stripeHeader(nowSeconds - 1000),
	})
	expect(staleStripe.status).toBe(401)
	expect(await staleStripe.json()).toEqual({
		ok: false,
		error: {
			code: 'invalid_signature',
			message: 'Webhook signature verification failed.',
		},
	})
	expect(await statusOf('stripe', { body })).toBe(401)
	const bodyOnlySignature = await sign(body, null)
	expect(
		await statusOf('stripe', {
			body,
			headers: {
				'stripe-signature': `t=${nowSeconds},v1=${bodyOnlySignature}`,
			},
		}),
	).toBe(401)

	for (const [timestampFormat, timestamp, status] of [
		['unix-seconds', String(nowSeconds), 202],
		['unix-seconds', String(nowSeconds * 1000), 401],
		['unix-millis', String(Date.now()), 202],
		['iso-8601', new Date().toISOString(), 202],
	] as const) {
		declareWebhook({
			name: 'unix',
			replay: { timestampHeader: 'X-Timestamp', timestampFormat },
		})
		expect(
			await statusOf('unix', { body, headers: { 'x-timestamp': timestamp } }),
		).toBe(status)
	}

	declareWebhook({
		name: 'github',
		responseMode: 'sync',
		verification: githubVerification,
		replay: { deliveryIdHeader: 'X-GitHub-Delivery' },
	})
	const githubBody = JSON.stringify({ ref: 'refs/heads/main' })
	const githubHeaders = {
		'x-hub-signature-256': await sign(githubBody),
		'x-github-delivery': 'delivery-abc',
	}
	const exportMock = createHashedIdempotencyExportMock()

	const firstGithub = await sendWebhook('github', {
		body: githubBody,
		headers: githubHeaders,
	})
	const firstGithubBody = await firstGithub.json()
	expect(firstGithub.status).toBe(200)
	expect(firstGithubBody).toEqual({ ok: true, result: { handled: true } })

	await new Promise((resolve) => setTimeout(resolve, 10))

	const replayedGithub = await sendWebhook('github', {
		body: githubBody,
		headers: githubHeaders,
	})
	expect(replayedGithub.status).toBe(200)
	expect(await replayedGithub.json()).toEqual(firstGithubBody)
	expect(exportMock.exportInvocations).toBe(1)
	expect(mocks.invokePackageExport).toHaveBeenCalledTimes(2)
	const [firstCall, secondCall] = [invoked(0), invoked(1)]
	expect(firstCall.idempotencyKey).toBe(secondCall.idempotencyKey)
	expect(firstCall.idempotencyKey).toBe(
		`${firstCall.idempotencyKey.slice(0, 64)}:enablement:${await enablementIdOf('github')}`,
	)
	expect(firstCall.idempotencyKey.slice(0, 64)).toMatch(/^[0-9a-f]{64}$/)
	expect(firstCall.idempotencyParamsHash).toBe('ignore')
	expect(secondCall.idempotencyParamsHash).toBe('ignore')
	expect(firstCall.params.webhook.receivedAt).not.toBe(
		secondCall.params.webhook.receivedAt,
	)

	const otherGithubBody = JSON.stringify({ ref: 'refs/heads/other' })
	const differentBodyReplay = await sendWebhook('github', {
		body: otherGithubBody,
		headers: {
			'x-hub-signature-256': await sign(otherGithubBody),
			'x-github-delivery': 'delivery-abc',
		},
	})
	expect(differentBodyReplay.status).toBe(200)
	expect(await differentBodyReplay.json()).toEqual(firstGithubBody)
	expect(exportMock.exportInvocations).toBe(1)

	expect(
		await statusOf('github', {
			body: githubBody,
			headers: { 'x-hub-signature-256': githubHeaders['x-hub-signature-256'] },
		}),
	).toBe(401)
	expect(exportMock.exportInvocations).toBe(1)
})

test('first-party trusted webhooks accept Idempotency-Key, params mode, and a higher rate limit', async () => {
	const userId = await setupOwnerWithWebhooks([
		'message-created',
		'burst',
		'vendor',
	])
	declareWebhook({
		name: 'message-created',
		responseMode: 'sync',
		inputMode: 'params',
	})
	const exportMock = createHashedIdempotencyExportMock()
	const postMessage = (body: unknown, headers?: Record<string, string>) =>
		sendWebhook('message-created', { body: JSON.stringify(body), headers })

	const envelope = {
		params: { messageId: 'm-1', content: 'hello' },
		idempotencyKey: 'evt-discord-1',
	}
	const first = await postMessage(envelope)
	expect(first.status).toBe(200)
	expect(await first.json()).toEqual({ ok: true, result: { handled: true } })
	expect(exportMock.exportInvocations).toBe(1)
	expect(invoked(0).params).toEqual({ messageId: 'm-1', content: 'hello' })
	const enablementSuffix = `:enablement:${await enablementIdOf('message-created')}`
	expect(invoked(0).idempotencyKey).toBe(`evt-discord-1${enablementSuffix}`)
	expect(invoked(0).idempotencyParamsHash).toBeUndefined()
	expect(invoked(0).idempotencyHashParams).toBeUndefined()

	const replay = await postMessage(envelope, {
		'Idempotency-Key': 'evt-discord-1',
	})
	expect(replay.status).toBe(200)
	expect(await replay.json()).toMatchObject({
		ok: true,
		result: { handled: true },
		idempotency: { replayed: true },
	})
	expect(exportMock.exportInvocations).toBe(1)

	const mismatch = await postMessage({
		params: { messageId: 'm-1', content: 'different' },
		idempotencyKey: 'evt-discord-1',
	})
	expect(mismatch.status).toBe(409)
	expect(await mismatch.json()).toMatchObject({
		ok: false,
		error: { code: 'idempotency_mismatch' },
	})
	expect(exportMock.exportInvocations).toBe(1)

	mocks.invokePackageExport.mockImplementationOnce(async () => ({
		status: 409,
		body: { ok: false, error: { code: 'invocation_in_progress' } },
	}))
	const inProgress = await postMessage({
		params: { messageId: 'm-9' },
		idempotencyKey: 'evt-in-progress',
	})
	expect(inProgress.status).toBe(409)
	expect(await inProgress.json()).toMatchObject({
		ok: false,
		error: { code: 'invocation_in_progress' },
	})

	const routedBody = {
		route: 'linkedin/register-video-upload',
		dryRun: false,
		params: { fileSizeBytes: 12, confirm: true },
	}
	for (const [directBody, key] of [
		[{ videoId: 'v-1' }, 'evt-direct-1'],
		[routedBody, 'evt-routed-1'],
	] as const) {
		expect(
			(await postMessage(directBody, { 'Idempotency-Key': key })).status,
		).toBe(200)
		expect(invoked(-1).params).toEqual(directBody)
		expect(invoked(-1).idempotencyKey).toBe(`${key}${enablementSuffix}`)
	}

	const invalidParams = await postMessage(['not', 'an', 'object'])
	expect(invalidParams.status).toBe(400)
	expect(await invalidParams.json()).toMatchObject({
		ok: false,
		error: { code: 'invalid_params' },
	})

	declareWebhook({
		name: 'burst',
		inputMode: 'params',
		rateLimitPerMinute: 2,
	})
	const burstStatuses = []
	for (const n of [1, 2, 3]) {
		burstStatuses.push(
			await statusOf('burst', {
				body: JSON.stringify({ n }),
				headers: { 'Idempotency-Key': `burst-${n}` },
			}),
		)
	}
	expect(burstStatuses).toEqual([202, 202, 429])
	expect(mocks.enqueueWebhookDispatch).toHaveBeenCalledTimes(2)
	expect(enqueued(0).callerIdempotency).toBe(true)

	await mintWebhook({ userId, webhookName: 'retired' })
	const retiredKey = `webhook:user:${userId}:endpoint:mint-retired`
	await checkRateLimit(env.APP_DB, retiredKey, webhookRateLimitConfig)
	const now = Math.floor(Date.now() / 1000)
	await env.APP_DB.batch(
		Array.from({ length: webhookRateLimitConfig.maxRequests - 1 }, () =>
			env.APP_DB.prepare(
				`INSERT INTO _rate_limits (key, ts) VALUES (?, ?)`,
			).bind(retiredKey, now),
		),
	)
	expect(await statusOf('retired', { body: JSON.stringify({ n: 1 }) })).toBe(
		429,
	)
	expect(await listDeliveries(userId, 'retired')).toEqual([])

	await useNamedSecret('vendor')
	declareWebhook({
		name: 'vendor',
		responseMode: 'sync',
		verification: githubVerification,
	})
	mockSecretValue(hmacSecret)
	const vendorBody = JSON.stringify({ ref: 'refs/heads/main' })
	expect(
		await statusOf('vendor', {
			body: vendorBody,
			headers: { 'x-hub-signature-256': await sign(vendorBody) },
		}),
	).toBe(200)
	expect(invoked(-1).params.webhook.name).toBe('vendor')
	expect(invoked(-1).params.request.json).toEqual({ ref: 'refs/heads/main' })
})

test('rotate overlap accepts the previous URL until the new URL is used or the grace expires', async () => {
	const userId = await setupOwnerWithWebhooks([])
	const previousSecret = 'previous-url-secret'
	const currentSecret = 'current-url-secret'
	await mintWebhook({
		userId,
		webhookName: 'overlap',
		urlSecret: currentSecret,
		previousUrlSecret: previousSecret,
		previousExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
	})
	const readOverlap = () =>
		env.APP_DB.prepare(
			`SELECT previous_url_secret_hash, previous_url_secret_expires_at
			FROM webhook_endpoints WHERE id = 'mint-overlap'`,
		).first<{
			previous_url_secret_hash: string | null
			previous_url_secret_expires_at: string | null
		}>()

	declareWebhook({ name: 'overlap' })
	expect(await statusOf('overlap', { urlSecret: previousSecret })).toBe(202)
	expect((await readOverlap())?.previous_url_secret_hash).toBeTruthy()

	await useNamedSecret('overlap')
	declareWebhook({ name: 'overlap', verification: githubVerification })
	mockSecretValue(hmacSecret)
	expect(await statusOf('overlap', { urlSecret: currentSecret })).toBe(401)
	expect((await readOverlap())?.previous_url_secret_hash).toBeTruthy()

	const confirmBody = JSON.stringify({ event: 'push' })
	expect(
		await statusOf('overlap', {
			urlSecret: currentSecret,
			body: confirmBody,
			headers: { 'x-hub-signature-256': await sign(confirmBody) },
		}),
	).toBe(202)
	expect(await readOverlap()).toEqual({
		previous_url_secret_hash: null,
		previous_url_secret_expires_at: null,
	})
	expect(await statusOf('overlap', { urlSecret: previousSecret })).toBe(404)

	await env.APP_DB.prepare(`DELETE FROM webhook_endpoints`).run()
	await mintWebhook({
		userId,
		webhookName: 'expired',
		urlSecret: currentSecret,
		previousUrlSecret: previousSecret,
		previousExpiresAt: '2026-07-23T00:00:00.000Z',
	})
	declareWebhook({ name: 'expired' })
	expect(await statusOf('expired', { urlSecret: previousSecret })).toBe(404)
	expect(await statusOf('expired', { urlSecret: currentSecret })).toBe(202)
})

test('subscription challenges answer on minted URLs without invoking exports', async () => {
	const userId = await setupOwnerWithWebhooks(['activity-event'])
	const hook = 'activity-event'
	const getChallenge = (query: string) =>
		sendWebhook(hook, { method: 'GET', query })
	const crcQuery = 'crc_token=x-crc-token'
	const crcChallenge = {
		type: 'subscription-challenge',
		method: 'GET',
		challenge: { in: 'query', key: 'crc_token' },
		prove: {
			kind: 'hmac',
			secretName: 'xConsumerSecret',
			algorithm: 'hmac-sha256',
			encoding: 'base64',
			prefix: 'sha256=',
		},
		respond: { as: 'json-hmac', key: 'response_token' },
	} as const

	declareWebhook({ name: hook, challenge: crcChallenge })
	mockSecretValue('consumer-secret')
	const crcResponse = await getChallenge(crcQuery)
	expect(crcResponse.status).toBe(200)
	const crcJson = (await crcResponse.json()) as { response_token: string }
	expect(crcJson.response_token).toMatch(/^sha256=/)
	expect(await listDeliveries(userId, hook)).toEqual([])
	mockSecretValue(null)
	expect((await getChallenge(crcQuery)).status).toBe(401)

	declareWebhook({
		name: hook,
		challenge: {
			type: 'subscription-challenge',
			method: 'POST',
			challenge: { in: 'json', key: 'challenge' },
			when: { json: { type: 'url_verification' } },
			prove: {
				kind: 'request-hmac',
				secretName: 'slackSigningSecret',
				algorithm: 'hmac-sha256',
				encoding: 'hex',
				prefix: 'v0=',
				timestampHeader: 'x-slack-request-timestamp',
				signatureHeader: 'x-slack-signature',
				signedPayload: 'v0.timestamp.body',
			},
			respond: { as: 'json', key: 'challenge' },
		},
	})
	const slackBody = JSON.stringify({
		type: 'url_verification',
		challenge: 'slack-challenge',
	})
	mockSecretValue('slack-signing-secret')
	const timestamp = String(Math.floor(Date.now() / 1000))
	const slackOk = await sendWebhook(hook, {
		body: slackBody,
		headers: {
			'x-slack-request-timestamp': timestamp,
			'x-slack-signature': await sign(
				`v0:${timestamp}:${slackBody}`,
				'v0=',
				'slack-signing-secret',
			),
		},
	})
	expect(slackOk.status).toBe(200)
	expect(await slackOk.json()).toEqual({ challenge: 'slack-challenge' })
	expect(mocks.invokePackageExport).not.toHaveBeenCalled()

	declareWebhook({ name: hook })
	const noChallengeGet = await getChallenge('crc_token=x')
	expect(noChallengeGet.status).toBe(405)
	expect(noChallengeGet.headers.get('Allow')).toBe('POST')

	await suspendOwner(userId, '2026-07-24T12:00:00.000Z')
	declareWebhook({ name: hook, challenge: crcChallenge })
	mockSecretValue('consumer-secret')
	expect((await getChallenge(crcQuery)).status).toBe(403)
	expect(await listDeliveries(userId, hook)).toEqual([])
})
