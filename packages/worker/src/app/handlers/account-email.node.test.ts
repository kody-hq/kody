import type * as authenticatedUserModule from '#app/authenticated-user.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import type * as emailVerification from '#app/email-verification.ts'
import type * as EntitlementPlans from '#universal/plans.ts'
import { type resolveEntitlementLimit } from '#universal/plans.ts'
import type * as ownerEmailReader from '#worker/email/owner-email-reader.ts'
import type * as EmailPlatformAddress from '#worker/email/platform-address.ts'
import type * as emailRepo from '#worker/email/repo.ts'
import type * as emailService from '#worker/email/service.ts'
import { type EmailMessageRecord } from '#worker/email/types.ts'
import type * as EntitlementService from '#worker/entitlements/service.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const messageRecord: EmailMessageRecord = {
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

const mockModule = await vi.hoisted(async () => {
	// Hoisted above static imports, so the id helpers load here.
	const { personIdFromStored } =
		await import('@kody-internal/shared/owner-person-ids.ts')
	const { sessionRequestContext } =
		await import('#worker/test-support/request-context.ts')
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
	return {
		authenticatedUser,
		readAuthenticatedAppUser: vi.fn<
			typeof authenticatedUserModule.readAuthenticatedAppUser
		>(async () => authenticatedUser),
		isAccountEmailVerified: vi.fn<
			typeof emailVerification.isAccountEmailVerified
		>(async () => true),
		getUserPlan: vi.fn<typeof EntitlementService.getUserPlan>(
			async () => 'free' as const,
		),
		getUserEntitlement: vi.fn<typeof EntitlementService.getUserEntitlement>(
			async () => ({
				plan: 'free' as const,
				ladder: 'public' as const,
				creditWallet: 'none',
			}),
		),
		readEntitlementResourceUsage: vi.fn<
			typeof EntitlementService.readEntitlementResourceUsage
		>(async () => 2),
		resolveEntitlementLimit: vi.fn<typeof resolveEntitlementLimit>(
			(_entitlement, resource) => {
				switch (resource) {
					case 'stored_email_messages':
						return 100
					case 'email_sends_per_day':
						return 20
					case 'email_receives_per_day':
						return 50
					case 'email_message_bytes':
						return 1_000_000
					default:
						return 0
				}
			},
		),
		getPlatformEmailDomain: vi.fn<
			typeof EmailPlatformAddress.getPlatformEmailDomain
		>(() => 'inbox.example.com'),
		listEmailInboxesForUser: vi.fn<typeof emailRepo.listEmailInboxesForUser>(
			async () => [
				{
					id: 'inbox-1',
					userId: ownerIdFromStored('stable-user-1'),
					packageId: null,
					name: 'default',
					description: '',
					enabled: true,
					createdAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
				},
			],
		),
		listEmailInboxAddressesForUser: vi.fn<
			typeof emailRepo.listEmailInboxAddressesForUser
		>(async () => [
			{
				id: 'addr-1',
				inboxId: 'inbox-1',
				userId: ownerIdFromStored('stable-user-1'),
				address: 'test-user@inbox.example.com',
				localPart: 'test-user',
				domain: 'inbox.example.com',
				enabled: true,
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
			},
		]),
		listOwnerEmailMessagesPage: vi.fn<
			typeof ownerEmailReader.listOwnerEmailMessagesPage
		>(async () => ({
			total: 1,
			messages: [messageRecord],
		})),
		getOwnerEmailMessageById: vi.fn<
			typeof ownerEmailReader.getOwnerEmailMessageById
		>(async () => messageRecord),
		listOwnerEmailAttachmentsForMessage: vi.fn<
			typeof ownerEmailReader.listOwnerEmailAttachmentsForMessage
		>(async () => [
			{
				id: 'att-1',
				messageId: 'msg-1',
				filename: 'note.txt',
				contentType: 'text/plain',
				contentId: null,
				disposition: 'attachment',
				size: 12,
				storageKind: 'inline',
				storageKey: null,
				createdAt: new Date(0).toISOString(),
			},
		]),
		listOwnerEmailDeliveryEvents: vi.fn<
			typeof ownerEmailReader.listOwnerEmailDeliveryEvents
		>(async () => [
			{
				id: 'evt-1',
				messageId: 'msg-1',
				userId: ownerIdFromStored('stable-user-1'),
				inboxId: 'inbox-1',
				eventType: 'received' as const,
				provider: 'cloudflare',
				providerMessageId: null,
				providerEventId: null,
				detailJson: '{}',
				createdAt: new Date(0).toISOString(),
			},
		]),
		setEmailMessageClassification: vi.fn<
			typeof emailService.setEmailMessageClassification
		>(async () => true),
		deleteEmailMessage: vi.fn<typeof emailService.deleteEmailMessage>(
			async () => true,
		),
		// Unverified personal inboxes ask whether the org is a users row.
		// A hit keeps the verification shell; this file's viewer is personal.
		prepare: vi.fn((_query: string) => ({
			bind: () => ({
				first: async () => ({ ok: 1 }),
				all: async () => ({ results: [] }),
				run: async () => ({ success: true, meta: {} }),
			}),
		})),
	}
})

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof authenticatedUserModule.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: async () => ({ session: null, setCookie: null }),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: () => new Response(null, { status: 302 }),
	redirectToLoginWhenUnauthenticated: () => new Response(null, { status: 302 }),
}))

vi.mock('#app/email-verification.ts', () => ({
	emailVerificationRequiredMessage:
		'Account email is not verified. Open the verification link sent to your account email, or resend it from /pending-verification or /account.',
	isAccountEmailVerified: (
		...args: Parameters<typeof emailVerification.isAccountEmailVerified>
	) => mockModule.isAccountEmailVerified(...args),
}))

vi.mock('#worker/entitlements/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementService>()
	return {
		...actual,
		getUserPlan: (...args: Parameters<typeof EntitlementService.getUserPlan>) =>
			mockModule.getUserPlan(...args),
		getUserEntitlement: (
			...args: Parameters<typeof EntitlementService.getUserEntitlement>
		) => mockModule.getUserEntitlement(...args),
		readEntitlementResourceUsage: (
			...args: Parameters<
				typeof EntitlementService.readEntitlementResourceUsage
			>
		) => mockModule.readEntitlementResourceUsage(...args),
		readCurrentEntitlementResourceUsage: (
			input: Parameters<typeof actual.readCurrentEntitlementResourceUsage>[0],
		) =>
			input.resource === 'stored_email_messages'
				? mockModule.readEntitlementResourceUsage(input)
				: actual.readCurrentEntitlementResourceUsage(input),
	}
})

vi.mock('#universal/plans.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementPlans>()
	return {
		...actual,
		resolveEntitlementLimit: (
			...args: Parameters<typeof resolveEntitlementLimit>
		) => mockModule.resolveEntitlementLimit(...args),
	}
})

vi.mock('#worker/email/platform-address.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EmailPlatformAddress>()
	return {
		...actual,
		getPlatformEmailDomain: (
			...args: Parameters<typeof EmailPlatformAddress.getPlatformEmailDomain>
		) => mockModule.getPlatformEmailDomain(...args),
	}
})

vi.mock('#worker/email/repo.ts', () => ({
	listEmailInboxesForUser: (
		...args: Parameters<typeof emailRepo.listEmailInboxesForUser>
	) => mockModule.listEmailInboxesForUser(...args),
	listEmailInboxAddressesForUser: (
		...args: Parameters<typeof emailRepo.listEmailInboxAddressesForUser>
	) => mockModule.listEmailInboxAddressesForUser(...args),
}))

vi.mock('#worker/email/inbound-sender.ts', () => ({
	classifyInboundEmailSender: vi.fn(async () => ({
		kind: 'unverified',
		reason: 'From address was not authenticated.',
	})),
}))

vi.mock('#worker/email/owner-email-reader.ts', () => ({
	listOwnerEmailMessagesPage: (
		...args: Parameters<typeof ownerEmailReader.listOwnerEmailMessagesPage>
	) => mockModule.listOwnerEmailMessagesPage(...args),
	getOwnerEmailMessageById: (
		...args: Parameters<typeof ownerEmailReader.getOwnerEmailMessageById>
	) => mockModule.getOwnerEmailMessageById(...args),
	listOwnerEmailAttachmentsForMessage: (
		...args: Parameters<
			typeof ownerEmailReader.listOwnerEmailAttachmentsForMessage
		>
	) => mockModule.listOwnerEmailAttachmentsForMessage(...args),
	listOwnerEmailDeliveryEvents: (
		...args: Parameters<typeof ownerEmailReader.listOwnerEmailDeliveryEvents>
	) => mockModule.listOwnerEmailDeliveryEvents(...args),
}))

vi.mock('#worker/email/service.ts', () => ({
	setEmailMessageClassification: (
		...args: Parameters<typeof emailService.setEmailMessageClassification>
	) => mockModule.setEmailMessageClassification(...args),
	deleteEmailMessage: (
		...args: Parameters<typeof emailService.deleteEmailMessage>
	) => mockModule.deleteEmailMessage(...args),
}))

const { testAccountEmailApiHandler } =
	await import('./account-email.test-support.ts')

function createEnv(input?: {
	meter?: ReturnType<typeof createInMemoryUserMeterEnv>
	messages?: Array<typeof messageRecord>
	messageTotal?: number
}) {
	const meter = input?.meter ?? createInMemoryUserMeterEnv()
	const messages = input?.messages ?? [messageRecord]
	const messageTotal = input?.messageTotal ?? messages.length
	mockModule.listOwnerEmailMessagesPage.mockImplementation(async () => ({
		total: messageTotal,
		messages,
	}))
	return {
		APP_DB: {
			prepare: (query: string) => mockModule.prepare(query),
		} as unknown as D1Database,
		APP_BASE_URL: 'https://example.com',
		COOKIE_SECRET: 'secret',
		...meter.env,
	} as Env
}

function useFrozenUtcTime(iso: string) {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date(iso))
	return {
		[Symbol.dispose]() {
			vi.useRealTimers()
		},
	}
}

function createEmailClient(env: Env) {
	const { execute } = testAccountEmailApiHandler(env)
	return {
		get: (search = '') =>
			execute({
				request: new Request(`https://example.com/account/email.json${search}`),
			}),
		post: (body: Record<string, unknown>, search = '') =>
			execute({
				request: new Request(
					`https://example.com/account/email.json${search}`,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(body),
					},
				),
			}),
		put: () =>
			execute({
				request: new Request('https://example.com/account/email.json', {
					method: 'PUT',
				}),
			}),
	}
}

test('email API lists messages with pagination, UserMeter usage, and owner-scoped selected detail', async () => {
	using _frozenTime = useFrozenUtcTime('2026-07-31T15:00:00.000Z')
	const day = utcDayKey()
	const userId = ownerIdFromStored('stable-user-1')
	const meter = createInMemoryUserMeterEnv()
	await meter.seed({ userId, resource: 'email_sends_per_day', day, count: 13 })
	await meter.seed({
		userId,
		resource: 'email_receives_per_day',
		day,
		count: 15,
	})
	const { get, put } = createEmailClient(createEnv({ meter }))

	const listResponse = await get()
	expect(listResponse.status).toBe(200)
	expect(mockModule.getOwnerEmailMessageById).not.toHaveBeenCalled()
	expect(listResponse.data).toMatchObject({
		ok: true,
		emailVerified: true,
		email: 'user@example.com',
		username: 'test-user',
		inboxAddress: 'test-user@inbox.example.com',
		verificationMessage: null,
		outboundDeliveryPausedAt: null,
		inboxes: [
			expect.objectContaining({
				id: 'inbox-1',
				addresses: [
					expect.objectContaining({
						address: 'test-user@inbox.example.com',
					}),
				],
			}),
		],
		messages: [
			expect.objectContaining({
				id: 'msg-1',
				subject: 'Hello from sender',
				direction: 'inbound',
				from_address: 'sender@example.com',
				classification: 'accepted',
				classification_reason: null,
			}),
		],
		selectedMessage: null,
		usage: expect.objectContaining({
			plan: 'free',
			day,
			stored_messages: { count: 2, limit: 100 },
			sends_today: { count: 13, limit: 20 },
			receives_today: { count: 15, limit: 50 },
			max_message_bytes: 1_000_000,
		}),
		page: 1,
		pageSize: 25,
		total: 1,
		query: '',
		classification: null,
	})

	const selectedResponse = await get(
		'?q=Hello&page=2&pageSize=10&selected=msg-1',
	)
	expect(selectedResponse.status).toBe(200)
	for (const fn of [
		mockModule.getOwnerEmailMessageById,
		mockModule.listOwnerEmailDeliveryEvents,
	]) {
		expect(fn).toHaveBeenCalledWith(
			expect.objectContaining({ ownerId: userId, messageId: 'msg-1' }),
		)
	}
	expect(selectedResponse.data).toMatchObject({
		ok: true,
		page: 2,
		pageSize: 10,
		query: 'Hello',
		classification: null,
		selectedMessage: expect.objectContaining({
			id: 'msg-1',
			text_body: 'Plain text body',
			html_body: '<p>HTML body</p>',
			classification: 'accepted',
			classification_reason: null,
			attachments: [
				expect.objectContaining({ id: 'att-1', filename: 'note.txt' }),
			],
			delivery_events: [
				expect.objectContaining({ id: 'evt-1', event_type: 'received' }),
			],
		}),
	})

	mockModule.getOwnerEmailMessageById.mockResolvedValueOnce(null as never)
	const missingSelection = await get('?selected=missing-msg')
	expect(missingSelection.status).toBe(200)
	expect(mockModule.getOwnerEmailMessageById).toHaveBeenLastCalledWith(
		expect.objectContaining({ ownerId: userId, messageId: 'missing-msg' }),
	)
	expect(missingSelection.data).toMatchObject({
		ok: true,
		selectedMessage: null,
	})

	expect((await put()).status).toBe(405)

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null as never)
	expect((await get()).status).toBe(401)
})

test('email API lists classification filters and classifies inbound messages', async () => {
	const quarantinedMessage = {
		...messageRecord,
		id: 'msg-quarantined',
		classification: 'quarantined' as const,
		classificationReason: 'DMARC failed.',
	}
	const meter = createInMemoryUserMeterEnv()
	const env = createEnv({ meter, messages: [quarantinedMessage] })
	mockModule.getOwnerEmailMessageById.mockResolvedValueOnce(quarantinedMessage)

	const { get, post } = createEmailClient(env)
	const listResponse = await get(
		'?classification=quarantined&selected=msg-quarantined',
	)
	expect(listResponse.status).toBe(200)
	const quarantinedFields = {
		id: 'msg-quarantined',
		classification: 'quarantined',
		classification_reason: 'DMARC failed.',
	}
	expect(listResponse.data).toMatchObject({
		ok: true,
		classification: 'quarantined',
		messages: [expect.objectContaining(quarantinedFields)],
		selectedMessage: expect.objectContaining(quarantinedFields),
	})

	// Mutation results are independent of the current list and selection.
	createEnv({ meter, messages: [messageRecord] })
	mockModule.getOwnerEmailMessageById.mockResolvedValue(messageRecord)
	const classify = (classification: string, messageId = 'msg-1') =>
		post({ action: 'classify', message_id: messageId, classification })
	const classifyCall = (
		classification: string,
		classificationReason: string | null,
	) => ({
		env,
		db: env.APP_DB,
		userId: ownerIdFromStored('stable-user-1'),
		messageId: 'msg-1',
		classification,
		classificationReason,
	})

	const quarantineResponse = await classify('quarantined')
	expect(quarantineResponse.status).toBe(200)
	expect(mockModule.setEmailMessageClassification).toHaveBeenLastCalledWith(
		classifyCall('quarantined', 'Reclassified by user.'),
	)
	expect(quarantineResponse.data).toMatchObject({
		ok: true,
		messageId: 'msg-1',
		classification: 'quarantined',
	})

	const acceptResponse = await classify('accepted')
	expect(acceptResponse.status).toBe(200)
	expect(mockModule.setEmailMessageClassification).toHaveBeenLastCalledWith(
		classifyCall('accepted', null),
	)

	mockModule.setEmailMessageClassification.mockResolvedValueOnce(false)
	expect((await classify('quarantined', 'missing')).status).toBe(404)
	expect((await post({ action: 'unknown' })).status).toBe(400)
})

test('email deletion succeeds without reading the list or usage again', async () => {
	const env = createEnv({ messages: [] })
	const { post } = createEmailClient(env)
	const deleteCall = (messageId: string) => ({
		env,
		db: env.APP_DB,
		userId: ownerIdFromStored('stable-user-1'),
		messageId,
	})

	const response = await post(
		{ action: 'delete', message_id: 'msg-1' },
		'?selected=msg-1',
	)
	expect(response.status).toBe(200)
	expect(mockModule.deleteEmailMessage).toHaveBeenCalledWith(
		deleteCall('msg-1'),
	)
	expect(response.data).toEqual({ ok: true, messageId: 'msg-1' })
	expect(mockModule.listEmailInboxesForUser).not.toHaveBeenCalled()

	mockModule.deleteEmailMessage.mockResolvedValueOnce(false)
	const missingResponse = await post({
		action: 'delete',
		message_id: 'foreign-or-missing',
	})
	expect(missingResponse.status).toBe(404)
	expect(mockModule.deleteEmailMessage).toHaveBeenLastCalledWith(
		deleteCall('foreign-or-missing'),
	)
})

test('email API gates unverified accounts and skips mailbox queries', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce({
		...mockModule.authenticatedUser,
		emailVerified: false,
	})
	mockModule.isAccountEmailVerified.mockResolvedValueOnce(false)

	const response = await createEmailClient(createEnv()).get()
	expect(response.status).toBe(200)
	expect(mockModule.listEmailInboxesForUser).not.toHaveBeenCalled()
	expect(mockModule.getUserPlan).not.toHaveBeenCalled()
	expect(mockModule.listOwnerEmailMessagesPage).not.toHaveBeenCalled()
	expect(response.data).toMatchObject({
		ok: true,
		emailVerified: false,
		inboxAddress: 'test-user@inbox.example.com',
		verificationMessage: expect.stringContaining('not verified'),
		messages: [],
		selectedMessage: null,
		usage: null,
		total: 0,
		classification: null,
	})
})

test('accepted email writes do not depend on an available page read', async () => {
	const env = createEnv()
	const { post } = createEmailClient(env)
	const read = mockModule.listOwnerEmailMessagesPage
	const original = read.getMockImplementation()!
	read.mockClear()
	read.mockRejectedValue(new Error('Email listing unavailable'))
	mockModule.getOwnerEmailMessageById.mockClear()
	try {
		expect(
			(
				await post({
					action: 'classify',
					message_id: 'msg-1',
					classification: 'accepted',
				})
			).data,
		).toEqual({ ok: true, messageId: 'msg-1', classification: 'accepted' })
		expect(
			(await post({ action: 'delete', message_id: 'msg-1' })).data,
		).toEqual({ ok: true, messageId: 'msg-1' })
		expect(read).not.toHaveBeenCalled()
		expect(mockModule.getOwnerEmailMessageById).not.toHaveBeenCalled()
	} finally {
		read.mockImplementation(original)
	}
})
