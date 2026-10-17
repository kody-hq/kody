import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { isAccountEmailVerified } from '#app/email-verification.ts'
import type * as EntitlementPlans from '#universal/plans.ts'
import { getUserEntitlement } from '#worker/entitlements/service.ts'
import type * as EntitlementService from '#worker/entitlements/service.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensureOrgLimitOverridesTestTable } from '#worker/users-test-schema.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const messageRecord = {
	id: 'msg-1',
	direction: 'inbound' as const,
	userId: ownerIdFromStored('stable-user-1'),
	inboxId: 'inbox-1',
	threadId: null,
	senderIdentityId: null,
	fromAddress: 'sender@example.com',
	envelopeFrom: 'sender@example.com',
	toAddresses: ['user@inbox.example.com'],
	ccAddresses: [],
	bccAddresses: [],
	replyToAddresses: [],
	subject: 'Hello from sender',
	messageIdHeader: '<msg-1@example.com>',
	inReplyToHeader: null,
	references: [],
	headers: { subject: ['Hello from sender'] },
	authResults: null,
	textBody: 'Plain text body',
	htmlBody: '<p>HTML body</p>',
	rawMimeKey: null,
	rawSize: 128,
	processingStatus: 'stored' as const,
	classification: 'accepted' as const,
	classificationReason: null,
	providerMessageId: null,
	deliveryStatus: null,
	deliveryStatusAt: null,
	error: null,
	receivedAt: new Date(0).toISOString(),
	sentAt: null,
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
}

const mocks = vi.hoisted(() => ({
	listOwnerEmailMessagesPage: vi.fn(),
	getOwnerEmailMessageById: vi.fn(),
	listOwnerEmailAttachmentsForMessage: vi.fn(),
	listOwnerEmailDeliveryEvents: vi.fn(),
	classifyInboundEmailSender: vi.fn(),
}))

vi.mock('#app/email-verification.ts', () => ({
	emailVerificationRequiredMessage: 'verify',
	isAccountEmailVerified: vi.fn(async () => true),
}))

vi.mock('#worker/email/outbound-consecutive-failures.ts', () => ({
	loadOutboundDeliveryPause: vi.fn(async () => ({
		pausedAt: null,
		consecutiveFailures: 0,
	})),
	clearOutboundDeliveryPause: vi.fn(async () => false),
	applyOutboundConsecutiveFailureTracking: vi.fn(async () => ({
		paused: false,
		consecutiveFailures: 0,
	})),
	emailOutboundDeliveryPausedMessage: 'paused',
	outboundConsecutiveFailurePauseThreshold: 5,
}))

vi.mock('#worker/entitlements/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementService>()
	return {
		...actual,
		getUserPlan: vi.fn(async () => 'free' as const),
		getUserEntitlement: vi.fn(async () => ({
			plan: 'free' as const,
			ladder: 'public' as const,
		})),
		readCurrentEntitlementResourceUsage: vi.fn(async () => 1),
		readDailyEntitlementResourceUsage: vi.fn(async () => 0),
	}
})

vi.mock('#universal/plans.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementPlans>()
	return {
		...actual,
		resolvePlanLimit: vi.fn(() => 100),
	}
})

vi.mock('#worker/email/platform-address.ts', () => ({
	getPlatformEmailDomain: vi.fn(() => null),
	buildPlatformEmailAddress: vi.fn(() => null),
}))

vi.mock('#worker/email/repo.ts', () => ({
	listEmailInboxesForUser: vi.fn(async () => []),
	listEmailInboxAddressesForUser: vi.fn(async () => []),
}))

vi.mock('#worker/email/inbound-sender.ts', () => ({
	classifyInboundEmailSender: mocks.classifyInboundEmailSender,
}))

vi.mock('#worker/email/owner-email-reader.ts', () => ({
	listOwnerEmailMessagesPage: mocks.listOwnerEmailMessagesPage,
	getOwnerEmailMessageById: mocks.getOwnerEmailMessageById,
	listOwnerEmailAttachmentsForMessage:
		mocks.listOwnerEmailAttachmentsForMessage,
	listOwnerEmailDeliveryEvents: mocks.listOwnerEmailDeliveryEvents,
}))

const { readAccountEmailData, loadAccountEmailDetail } =
	await import('./account-email-data.ts')

const authenticatedUser: AuthenticatedAppUser = {
	sessionUserId: '42',
	userId: 42,
	username: 'test-user',
	email: 'user@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	displayName: 'user',
	roles: ['user'],
	permissions: [],
	artifactOwnerIds: [],
	mcpUser: {
		userId: personIdFromStored('stable-user-1'),
		email: 'user@example.com',
		username: 'test-user',
		displayName: 'user',
	},
	request: sessionRequestContext('stable-user-1', 'test-user'),
}

test('readAccountEmailData reads USER message graph only through owner Mailbox readers', async () => {
	mocks.classifyInboundEmailSender.mockResolvedValue({
		kind: 'unverified',
		reason: 'From address was not authenticated.',
	})
	mocks.listOwnerEmailMessagesPage.mockResolvedValueOnce({
		total: 1,
		messages: [messageRecord],
	})
	mocks.getOwnerEmailMessageById.mockResolvedValueOnce(messageRecord)
	mocks.listOwnerEmailAttachmentsForMessage.mockResolvedValueOnce([])
	mocks.listOwnerEmailDeliveryEvents.mockResolvedValueOnce([])
	const prepare = vi.fn()
	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: { prepare } as unknown as D1Database,
		APP_BASE_URL: 'https://example.com',
		COOKIE_SECRET: 'secret',
		...meter.env,
	} as Env

	const result = await readAccountEmailData({
		env,
		page: 1,
		pageSize: 25,
		query: '',
		classification: null,
		selectedMessageId: 'msg-1',
		user: authenticatedUser,
	})

	expect(result.messages).toEqual([
		expect.objectContaining({
			id: 'msg-1',
			subject: 'Hello from sender',
			classification: 'accepted',
		}),
	])
	expect(result.selectedMessage?.id).toBe('msg-1')
	expect(mocks.listOwnerEmailMessagesPage).toHaveBeenCalledWith(
		expect.objectContaining({
			env,
			ownerId: ownerIdFromStored('stable-user-1'),
		}),
	)
	expect(mocks.getOwnerEmailMessageById).toHaveBeenCalledWith({
		env,
		ownerId: ownerIdFromStored('stable-user-1'),
		messageId: 'msg-1',
	})
	expect(prepare).not.toHaveBeenCalled()
	expect(result.messages[0]?.sender_classification).toBe('unverified')
	expect(result.selectedMessage?.sender_classification).toBe('unverified')
	expect(result.selectedMessage?.enable_sender).toBeNull()
})

test('readAccountEmailData uses the org slug for a team inbox and exposes a member sender', async () => {
	const memberId = 'c'.repeat(64)
	mocks.classifyInboundEmailSender.mockResolvedValue({
		kind: 'member',
		actor: { userId: personIdFromStored(memberId), username: 'ada' },
		role: 'member',
	})
	mocks.listOwnerEmailMessagesPage.mockResolvedValueOnce({
		total: 1,
		messages: [messageRecord],
	})
	mocks.getOwnerEmailMessageById.mockResolvedValueOnce(messageRecord)
	mocks.listOwnerEmailAttachmentsForMessage.mockResolvedValueOnce([])
	mocks.listOwnerEmailDeliveryEvents.mockResolvedValueOnce([])
	const { getPlatformEmailDomain, buildPlatformEmailAddress } =
		await import('#worker/email/platform-address.ts')
	vi.mocked(getPlatformEmailDomain).mockReturnValueOnce('inbox.example.com')
	vi.mocked(buildPlatformEmailAddress).mockImplementationOnce(
		({ username, domain }) => `${username}@${domain}`,
	)
	const prepare = vi.fn(() => ({
		bind: () => ({
			all: async () => ({ results: [{ kody_id: 'digest' }] }),
		}),
	}))
	const meter = createInMemoryUserMeterEnv()
	const orgId = ownerIdFromStored('team-org')
	const env = {
		APP_DB: { prepare } as unknown as D1Database,
		APP_BASE_URL: 'https://example.com',
		COOKIE_SECRET: 'secret',
		...meter.env,
	} as Env
	const result = await readAccountEmailData({
		env,
		page: 1,
		pageSize: 25,
		query: '',
		classification: null,
		selectedMessageId: 'msg-1',
		user: {
			...authenticatedUser,
			username: 'viewer',
			request: deriveRequestContext({
				user: {
					userId: personIdFromStored('stable-user-1'),
					username: 'viewer',
				},
				source: { kind: 'session' },
				orgBinding: { org: { id: orgId, slug: 'acme' }, role: 'owner' },
			}),
		},
	})

	expect(result.inboxAddress).toBe('acme@inbox.example.com')
	expect(buildPlatformEmailAddress).toHaveBeenCalledWith({
		username: 'acme',
		domain: 'inbox.example.com',
	})
	expect(result.messages[0]?.sender_classification).toBe('member')
	expect(result.selectedMessage).toMatchObject({
		sender_classification: 'member',
		sender_classification_reason: 'From is a verified org member.',
		enable_sender: {
			sender: { kind: 'member', value: memberId },
			topic: 'email.message.received',
			org_slug: 'acme',
			packages: [{ kody_id: 'digest' }],
		},
	})
	expect(result.selectedMessage?.enable_sender?.packages_href).toContain(
		'/@acme/-/repositories?',
	)
	expect(result.selectedMessage?.enable_sender?.packages_href).toContain(
		'sender_kind=member',
	)
	expect(mocks.listOwnerEmailMessagesPage).toHaveBeenCalledWith(
		expect.objectContaining({ ownerId: orgId }),
	)
})

test('readAccountEmailData refuses a member without email:read', async () => {
	mocks.listOwnerEmailMessagesPage.mockClear()
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	const orgId = ownerIdFromStored('d'.repeat(64))
	const now = new Date(0).toISOString()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, created_at, updated_at)
			 VALUES (?, 'acme', ?, ?)`,
		)
		.bind(orgId, now, now)
		.run()
	const meter = createInMemoryUserMeterEnv()
	await expect(
		readAccountEmailData({
			env: {
				APP_DB: db,
				APP_BASE_URL: 'https://example.com',
				COOKIE_SECRET: 'secret',
				...meter.env,
			} as Env,
			page: 1,
			pageSize: 25,
			query: '',
			classification: null,
			user: {
				...authenticatedUser,
				request: deriveRequestContext({
					user: {
						userId: personIdFromStored('e'.repeat(64)),
						username: 'member',
					},
					source: { kind: 'session' },
					orgBinding: { org: { id: orgId, slug: 'acme' }, role: 'member' },
				}),
			},
		}),
	).rejects.toMatchObject({ permission: 'email:read' })
	expect(mocks.listOwnerEmailMessagesPage).not.toHaveBeenCalled()
	mocks.getOwnerEmailMessageById.mockClear()
	await expect(
		loadAccountEmailDetail({
			env: { APP_DB: db } as Env,
			user: {
				...authenticatedUser,
				request: deriveRequestContext({
					user: {
						userId: personIdFromStored('e'.repeat(64)),
						username: 'member',
					},
					source: { kind: 'session' },
					orgBinding: { org: { id: orgId, slug: 'acme' }, role: 'member' },
				}),
			},
			messageId: 'msg-1',
		}),
	).rejects.toMatchObject({ permission: 'email:read' })
	expect(mocks.getOwnerEmailMessageById).not.toHaveBeenCalled()
})

async function usersAndOrgsDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await ensureOrgLimitOverridesTestTable(db)
	await db
		.prepare(
			`CREATE TABLE users (
				stable_user_id TEXT PRIMARY KEY,
			personal_org_id TEXT,
				email TEXT,
				deleted_at TEXT,
				deleting_at TEXT
			)`,
		)
		.run()
	return db
}

test('readAccountEmailData hides a personal inbox until the account email is verified', async () => {
	vi.mocked(isAccountEmailVerified).mockResolvedValueOnce(false)
	mocks.listOwnerEmailMessagesPage.mockClear()
	const db = await usersAndOrgsDb()
	const orgId = personalOrgId(personIdFromStored('stable-user-1'))
	await db
		.prepare(
			`INSERT INTO users (stable_user_id, email, deleted_at, deleting_at)
			 VALUES (?, 'user@example.com', NULL, NULL)`,
		)
		.bind(orgId)
		.run()
	const meter = createInMemoryUserMeterEnv()
	const result = await readAccountEmailData({
		env: {
			APP_DB: db,
			APP_BASE_URL: 'https://example.com',
			COOKIE_SECRET: 'secret',
			...meter.env,
		} as Env,
		page: 1,
		pageSize: 25,
		query: '',
		classification: null,
		user: { ...authenticatedUser, emailVerified: false },
	})
	expect(result.emailVerified).toBe(false)
	expect(result.messages).toEqual([])
	expect(result.usage).toBeNull()
	expect(mocks.listOwnerEmailMessagesPage).not.toHaveBeenCalled()
})

test('readAccountEmailData shows a team inbox to an unverified owner with email:read', async () => {
	vi.mocked(isAccountEmailVerified).mockResolvedValueOnce(false)
	mocks.classifyInboundEmailSender.mockResolvedValue({
		kind: 'unverified',
		reason: 'From address was not authenticated.',
	})
	mocks.listOwnerEmailMessagesPage.mockResolvedValueOnce({
		total: 1,
		messages: [messageRecord],
	})
	const db = await usersAndOrgsDb()
	const orgId = ownerIdFromStored('a'.repeat(64))
	const viewerId = personIdFromStored('b'.repeat(64))
	const now = new Date(0).toISOString()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, created_at, updated_at)
			 VALUES (?, 'acme', ?, ?)`,
		)
		.bind(orgId, now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO users (stable_user_id, email, deleted_at, deleting_at)
			 VALUES (?, 'ada@example.com', NULL, NULL)`,
		)
		.bind(viewerId)
		.run()
	const meter = createInMemoryUserMeterEnv()
	const result = await readAccountEmailData({
		env: {
			APP_DB: db,
			APP_BASE_URL: 'https://example.com',
			COOKIE_SECRET: 'secret',
			...meter.env,
		} as Env,
		page: 1,
		pageSize: 25,
		query: '',
		classification: null,
		user: {
			...authenticatedUser,
			email: 'ada@example.com',
			emailVerified: false,
			username: 'ada',
			mcpUser: {
				...authenticatedUser.mcpUser,
				userId: viewerId,
				email: 'ada@example.com',
				username: 'ada',
			},
			request: deriveRequestContext({
				user: { userId: viewerId, username: 'ada' },
				source: { kind: 'session' },
				orgBinding: { org: { id: orgId, slug: 'acme' }, role: 'owner' },
			}),
		},
	})
	expect(result.emailVerified).toBe(true)
	expect(result.verificationMessage).toBeNull()
	expect(result.messages).toEqual([
		expect.objectContaining({ id: 'msg-1', subject: 'Hello from sender' }),
	])
	expect(mocks.listOwnerEmailMessagesPage).toHaveBeenCalledWith(
		expect.objectContaining({ ownerId: orgId }),
	)
})

test('readAccountEmailData shows a paid team plan instead of the viewer email free plan', async () => {
	const actual = await vi.importActual<typeof EntitlementService>(
		'#worker/entitlements/service.ts',
	)
	vi.mocked(getUserEntitlement).mockImplementation(
		actual.getUserEntitlement as typeof getUserEntitlement,
	)
	mocks.classifyInboundEmailSender.mockResolvedValue({
		kind: 'unverified',
		reason: 'From address was not authenticated.',
	})
	mocks.listOwnerEmailMessagesPage.mockResolvedValueOnce({
		total: 0,
		messages: [],
	})
	const db = await usersAndOrgsDb()
	const orgId = ownerIdFromStored('c'.repeat(64))
	const viewerId = personIdFromStored('d'.repeat(64))
	const now = new Date(0).toISOString()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
			 VALUES (?, 'acme', 'pro', ?, ?)`,
		)
		.bind(orgId, now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO users (stable_user_id, email, deleted_at, deleting_at)
			 VALUES (?, 'ada@example.com', NULL, NULL)`,
		)
		.bind(viewerId)
		.run()
	const meter = createInMemoryUserMeterEnv()
	const result = await readAccountEmailData({
		env: {
			APP_DB: db,
			APP_BASE_URL: 'https://example.com',
			COOKIE_SECRET: 'secret',
			...meter.env,
		} as Env,
		page: 1,
		pageSize: 25,
		query: '',
		classification: null,
		user: {
			...authenticatedUser,
			email: 'ada@example.com',
			emailVerified: true,
			username: 'ada',
			mcpUser: {
				...authenticatedUser.mcpUser,
				userId: viewerId,
				email: 'ada@example.com',
				username: 'ada',
			},
			request: deriveRequestContext({
				user: { userId: viewerId, username: 'ada' },
				source: { kind: 'session' },
				orgBinding: { org: { id: orgId, slug: 'acme' }, role: 'owner' },
			}),
		},
	})
	expect(getUserEntitlement).toHaveBeenCalledWith(
		db,
		expect.objectContaining({ userId: orgId, email: null }),
	)
	expect(result.usage).toMatchObject({
		plan: 'pro',
		sends_today: { limit: 500 },
		receives_today: { limit: 2_000 },
		stored_messages: { limit: 25_000 },
		max_message_bytes: 768 * 1024,
	})
})

test('detail reads only the owner-scoped message graph, without list or usage work', async () => {
	vi.clearAllMocks()
	mocks.classifyInboundEmailSender.mockResolvedValueOnce({
		kind: 'unverified',
		reason: 'From address was not authenticated.',
	})
	mocks.getOwnerEmailMessageById.mockResolvedValueOnce(messageRecord)
	mocks.listOwnerEmailAttachmentsForMessage.mockResolvedValueOnce([])
	mocks.listOwnerEmailDeliveryEvents.mockResolvedValueOnce([])
	const env = { APP_DB: {} } as Env
	const detail = await loadAccountEmailDetail({
		env,
		user: authenticatedUser,
		messageId: 'msg-1',
	})
	expect(detail?.id).toBe('msg-1')
	expect(mocks.getOwnerEmailMessageById).toHaveBeenCalledWith({
		env,
		ownerId: ownerIdFromStored('stable-user-1'),
		messageId: 'msg-1',
	})
	expect(mocks.listOwnerEmailMessagesPage).not.toHaveBeenCalled()
	const { getUserEntitlement } = await import('#worker/entitlements/service.ts')
	expect(getUserEntitlement).not.toHaveBeenCalled()
})

test('detail requires verified email before reading any message data', async () => {
	vi.clearAllMocks()
	const { isAccountEmailVerified } = await import('#app/email-verification.ts')
	vi.mocked(isAccountEmailVerified).mockResolvedValueOnce(false)
	const detail = await loadAccountEmailDetail({
		env: { APP_DB: {} } as Env,
		user: { ...authenticatedUser, emailVerified: false },
		messageId: 'msg-1',
	})
	expect(detail).toBeNull()
	expect(mocks.getOwnerEmailMessageById).not.toHaveBeenCalled()
	expect(mocks.listOwnerEmailAttachmentsForMessage).not.toHaveBeenCalled()
})
