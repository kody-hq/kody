import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { http, HttpResponse } from 'msw'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { metaPlatformFeedbackSubmitCapability } from '#mcp/capabilities/meta/meta-platform-feedback-submit.ts'
import { submitWebsiteCancellationFeedback } from '#app/handlers/org-billing.ts'
import type * as authenticatedUserModule from '#app/authenticated-user.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import {
	platformFeedbackAcknowledgementEmailClaimTtlSeconds,
	platformFeedbackAcknowledgementEmailKvKey,
	sendPlatformFeedbackAcknowledgementEmail,
} from './acknowledgement-email.ts'
import { platformFeedbackTestSchemaSql } from './test-schema.ts'
import { type PlatformFeedbackRecord } from './types.ts'

const captureException = vi.hoisted(() => vi.fn())

vi.mock('@sentry/cloudflare', async () => {
	const stub = await import('#worker/test-support/sentry-cloudflare-stub.ts')
	return {
		...stub,
		captureException: (...args: Array<unknown>) => captureException(...args),
	}
})

const authMock = vi.hoisted(() => ({
	readAuthenticatedAppUser:
		vi.fn<typeof authenticatedUserModule.readAuthenticatedAppUser>(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof authenticatedUserModule.readAuthenticatedAppUser>
	) => authMock.readAuthenticatedAppUser(...args),
}))

vi.mock('./package-subscriptions.ts', () => ({
	dispatchPlatformFeedbackSubmittedSubscriptionEvent: async () => [],
}))

const { handlePlatformFeedbackDispatchQueue } =
	await import('./dispatch-queue.ts')

const mockAccountId = 'cf_account_ack_test'
const mockApiBaseUrl = 'https://api.cloudflare.test'

type CapturedSend = {
	to: string
	from: string
	subject: string
	html: string
	text?: string
	reply_to?: string
}

function createKv(order?: Array<string>) {
	const store = new Map<string, string>()
	const puts: Array<{ key: string; options?: { expirationTtl?: number } }> = []
	const kv = {
		get: async (key: string) => store.get(key) ?? null,
		async put(
			key: string,
			value: string,
			options?: { expirationTtl?: number },
		) {
			order?.push('put')
			puts.push({ key, options })
			store.set(key, value)
		},
		delete: async (key: string) => {
			order?.push('delete')
			store.delete(key)
		},
	} as unknown as KVNamespace
	return { kv, store, puts }
}

function createUsersAndFeedbackDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(platformFeedbackTestSchemaSql)
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL DEFAULT 'x',
			stable_user_id TEXT NOT NULL UNIQUE,
			personal_org_id TEXT,
			suspended_at TEXT,
			deleted_at TEXT
		);
		CREATE TABLE orgs (
			id TEXT PRIMARY KEY,
			email_outbound_paused_at TEXT,
			deleted_at TEXT
		);
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function seedUser(
	sqlite: DatabaseSync,
	input: {
		stableUserId: string
		email?: string
		suspendedAt?: string | null
		emailOutboundPausedAt?: string | null
		deletedAt?: string | null
	},
) {
	sqlite
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id,
				suspended_at, deleted_at
			) VALUES (?, ?, 'x', ?, ?, ?)`,
		)
		.run(
			input.stableUserId,
			input.email ?? `${input.stableUserId}@example.com`,
			input.stableUserId,
			input.suspendedAt ?? null,
			input.deletedAt ?? null,
		)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, email_outbound_paused_at)
			 VALUES (?, ?)`,
		)
		.run(input.stableUserId, input.emailOutboundPausedAt ?? null)
}

function createEmailCaptureServer(sent: Array<CapturedSend>, fail = false) {
	return createMswNodeServer(
		[
			http.post(
				`${mockApiBaseUrl}/client/v4/accounts/${mockAccountId}/email/sending/send`,
				async ({ request }) => {
					const body = (await request.json()) as CapturedSend
					sent.push(body)
					if (fail) {
						return HttpResponse.json(
							{
								success: false,
								errors: [{ message: 'provider rejected' }],
							},
							{ status: 502 },
						)
					}
					return HttpResponse.json({
						success: true,
						result: {
							message_id: `email_${sent.length}`,
							delivered: [body.to],
							permanent_bounces: [],
							queued: [],
						},
					})
				},
			),
		],
		{ onUnhandledFrame: 'bypass' },
	)
}

function createEnv(input: {
	db: D1Database
	kv?: KVNamespace
	queueSend?: (body: unknown) => Promise<void>
}) {
	return {
		APP_BASE_URL: 'https://kody.codes/',
		CLOUDFLARE_ACCOUNT_ID: mockAccountId,
		CLOUDFLARE_API_BASE_URL: mockApiBaseUrl,
		CLOUDFLARE_API_TOKEN: 'token',
		APP_DB: input.db,
		BUNDLE_ARTIFACTS_KV: input.kv,
		PLATFORM_FEEDBACK_DISPATCH_QUEUE: {
			send: input.queueSend ?? (async () => undefined),
		},
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
	} as unknown as Env
}

const openFeedback: PlatformFeedbackRecord = {
	id: 'feedback-ack-1',
	submitterUserId: 'user-1',
	submitterUsername: 'user-1',
	submitterEmail: 'user-1@example.com',
	category: 'friction',
	summary: 'Setup is confusing',
	details: 'The setup flow does not explain the next action.',
	status: 'open',
	reviewedByUserId: null,
	reviewedAt: null,
	adminNote: null,
	resolutionNote: null,
	resolutionPrUrls: [],
	createdAt: '2026-07-19T00:00:00.000Z',
	updatedAt: '2026-07-19T00:00:00.000Z',
}

test('platform feedback acknowledgement emails send once, skip unsafe recipients, and never fail submit', async () => {
	const sent: Array<CapturedSend> = []
	using _server = createEmailCaptureServer(sent)
	const { sqlite, db } = createUsersAndFeedbackDb()
	seedUser(sqlite, { stableUserId: ownerIdFromStored('user-1') })
	const { kv, store, puts } = createKv()
	const env = createEnv({ db, kv })

	expect(
		await sendPlatformFeedbackAcknowledgementEmail({
			env: createEnv({ db }),
			feedback: openFeedback,
		}),
	).toBe(false)
	expect(sent).toHaveLength(0)

	expect(
		await sendPlatformFeedbackAcknowledgementEmail({
			env,
			feedback: openFeedback,
		}),
	).toBe(true)
	expect(sent).toHaveLength(1)
	expect(sent[0]).toMatchObject({
		to: 'user-1@example.com',
		from: 'kody@kody.codes',
		subject: 'We got your Kody feedback',
	})
	expect(sent[0]?.text).toContain('feedback-ack-1')
	expect(sent[0]?.text).toContain('metaPlatformFeedbackGet')
	expect(sent[0]?.html).toContain('feedback-ack-1')
	expect(sent[0]?.html).toContain('metaPlatformFeedbackGet')
	expect(
		store.get(platformFeedbackAcknowledgementEmailKvKey('feedback-ack-1')),
	).toBeTruthy()
	expect(puts[0]?.options?.expirationTtl).toBe(
		platformFeedbackAcknowledgementEmailClaimTtlSeconds,
	)

	expect(
		await sendPlatformFeedbackAcknowledgementEmail({
			env,
			feedback: openFeedback,
		}),
	).toBe(false)
	expect(sent).toHaveLength(1)

	const skipped = [
		{
			id: 'feedback-deleted',
			user: {
				stableUserId: ownerIdFromStored('deleted-user'),
				deletedAt: '2026-07-20T00:00:00.000Z',
			},
		},
		{
			id: 'feedback-paused',
			user: {
				stableUserId: ownerIdFromStored('paused-user'),
				emailOutboundPausedAt: '2026-07-20T00:00:00.000Z',
			},
		},
		{
			id: 'feedback-suspended',
			user: {
				stableUserId: ownerIdFromStored('suspended-user'),
				suspendedAt: '2026-07-20T00:00:00.000Z',
			},
		},
		{ id: 'feedback-missing', user: null },
	] as const
	for (const case_ of skipped) {
		if (case_.user) seedUser(sqlite, case_.user)
		expect(
			await sendPlatformFeedbackAcknowledgementEmail({
				env,
				feedback: {
					...openFeedback,
					id: case_.id,
					submitterUserId: case_.user?.stableUserId ?? 'missing-user',
				},
			}),
		).toBe(false)
	}
	expect(sent).toHaveLength(1)
	expect(captureException).not.toHaveBeenCalled()
})

test('platform feedback acknowledgement send failures release the claim, log, and report to Sentry', async () => {
	const sent: Array<CapturedSend> = []
	using _server = createEmailCaptureServer(sent, true)
	consoleWarn.mockImplementation(() => {})
	const order: Array<string> = []
	const { sqlite, db } = createUsersAndFeedbackDb()
	seedUser(sqlite, { stableUserId: ownerIdFromStored('user-fail') })
	const { kv, store } = createKv(order)
	const env = createEnv({ db, kv })

	expect(
		await sendPlatformFeedbackAcknowledgementEmail({
			env,
			feedback: {
				...openFeedback,
				id: 'feedback-fail',
				submitterUserId: 'user-fail',
			},
		}),
	).toBe(false)
	expect(order).toEqual(['put', 'delete'])
	expect(
		store.get(platformFeedbackAcknowledgementEmailKvKey('feedback-fail')),
	).toBeUndefined()
	expect(consoleWarn).toHaveBeenCalledWith(
		'platform-feedback-acknowledgement-email-send-failed',
		{
			feedbackId: 'feedback-fail',
			error: expect.any(Error),
		},
	)
	expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
		tags: { scope: 'platform-feedback-acknowledgement-email' },
		extra: { feedbackId: 'feedback-fail' },
	})
})

async function drainDispatchQueue(env: Env, queueBodies: Array<unknown>) {
	const messages = queueBodies.splice(0).map((body, index) => ({
		id: `queue-${String(index)}`,
		timestamp: new Date('2026-07-19T00:01:00.000Z'),
		body,
		attempts: 1,
		ack: vi.fn(),
		retry: vi.fn(),
	}))
	await handlePlatformFeedbackDispatchQueue(
		{
			queue: 'kody-platform-feedback-dispatch',
			messages,
			ackAll: vi.fn(),
			retryAll: vi.fn(),
		} as unknown as MessageBatch<unknown>,
		env,
		{} as ExecutionContext,
	)
	return messages
}

test('meta submit and billing cancellation both send one acknowledgement through the shared dispatch queue', async () => {
	const sent: Array<CapturedSend> = []
	using _server = createEmailCaptureServer(sent)
	const { sqlite, db } = createUsersAndFeedbackDb()
	seedUser(sqlite, {
		stableUserId: ownerIdFromStored('user-meta'),
		email: 'meta@example.com',
	})
	seedUser(sqlite, {
		stableUserId: ownerIdFromStored('stable-ada'),
		email: 'ada@example.com',
	})
	const { kv } = createKv()
	const queueBodies: Array<unknown> = []
	const env = createEnv({
		db,
		kv,
		queueSend: async (body) => {
			queueBodies.push(body)
		},
	})

	const metaResult = await metaPlatformFeedbackSubmitCapability.handler(
		{
			category: 'bug',
			summary: 'Meta path acknowledgement',
			details: 'Submitted through metaPlatformFeedbackSubmit.',
			user_confirmed: true,
		},
		{
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				executionOrigin: 'interactive',
				user: {
					userId: personIdFromStored('user-meta'),
					username: 'user-meta',
					email: 'meta@example.com',
					displayName: 'user-meta',
					roles: ['user'],
				},
			}),
		},
	)
	expect(metaResult.status).toBe('open')
	expect(typeof metaResult.feedback_id).toBe('string')
	expect(sent).toHaveLength(0)
	expect(queueBodies).toEqual([{ feedbackId: metaResult.feedback_id }])

	await drainDispatchQueue(env, queueBodies)
	expect(sent).toHaveLength(1)
	expect(sent[0]?.to).toBe('meta@example.com')
	expect(sent[0]?.subject).toContain('got your')
	expect(sent[0]?.text).toContain(metaResult.feedback_id)
	expect(sent[0]?.text).toContain('metaPlatformFeedbackGet')

	// Re-processing the same feedback id does not send again.
	queueBodies.push({ feedbackId: metaResult.feedback_id })
	await drainDispatchQueue(env, queueBodies)
	expect(sent).toHaveLength(1)

	const authenticatedUser: AuthenticatedAppUser = {
		sessionUserId: '9',
		userId: 9,
		username: 'ada',
		email: 'ada@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'ada',
		roles: ['user'],
		permissions: [],
		artifactOwnerIds: ['9'],
		mcpUser: {
			userId: personIdFromStored('stable-ada'),
			email: 'ada@example.com',
			displayName: 'ada',
		},
		request: sessionRequestContext('stable-ada'),
	}
	authMock.readAuthenticatedAppUser.mockResolvedValue(authenticatedUser)
	const url = new URL(
		'https://example.com/account/billing/cancellation-feedback.json',
	)
	const billingResponse = await submitWebsiteCancellationFeedback({
		env,
		user: authenticatedUser,
		body: { details: 'Leaving because acknowledgement coverage matters.' },
		request: new Request(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				details: 'Leaving because acknowledgement coverage matters.',
			}),
		}),
		params: {},
		url,
	} as never)
	expect(billingResponse.status).toBe(200)
	expect(billingResponse.data).toEqual({ ok: true })
	expect(sent).toHaveLength(1)
	expect(queueBodies).toHaveLength(1)

	await drainDispatchQueue(env, queueBodies)
	expect(sent).toHaveLength(2)
	expect(sent[1]?.to).toBe('ada@example.com')
	expect(sent[1]?.text).toContain('metaPlatformFeedbackGet')
})
