import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import type * as PackageInvocations from '#worker/package-invocations/service.ts'

const inboundEmailReceiptTopic = 'email.message.received'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn<
		typeof PackageInvocations.invokePackageSubscription
	>(async () => ({
		status: 200,
		body: { result: { ok: true } },
	})),
	getSavedPackageById: vi.fn(),
	resolveSavedPackageRef: vi.fn(),
	resolvePackageOwnerContext: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	getInternalEmailMessageById: vi.fn(),
	listInternalEmailAttachmentsForMessage: vi.fn(),
}))

vi.mock('#worker/email/package-subscriptions.ts', () => ({
	buildEmailReceiptSubscriptionEnvelope: vi.fn(
		(input: {
			event: string
			message: { id: string }
			attachments: Array<unknown>
		}) => ({
			event: input.event,
			message: { id: input.message.id },
			attachments: input.attachments,
		}),
	),
	inboundEmailReceiptTopic: 'email.message.received',
	inboundEmailQuarantinedTopic: 'email.message.quarantined',
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageSubscription: mocks.invokePackageSubscription,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: mocks.getSavedPackageById,
	resolveSavedPackageRef: mocks.resolveSavedPackageRef,
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	resolvePackageOwnerContext: mocks.resolvePackageOwnerContext,
}))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

vi.mock('#worker/email/mailbox-internal-read.ts', () => ({
	getInternalEmailMessageById: mocks.getInternalEmailMessageById,
	listInternalEmailAttachmentsForMessage:
		mocks.listInternalEmailAttachmentsForMessage,
}))

const { packageSubscriptionDispatchCapability } =
	await import('./package-subscription-dispatch.ts')

const savedPackage = {
	id: 'pkg-1',
	userId: ownerIdFromStored('user-1'),
	sourceId: 'source-1',
	kodyId: 'demo',
	name: '@user/demo',
	description: 'Demo package',
	tags: [],
	searchText: null,
	hasApp: false,
	hidden: false,
	isPrivate: false,
	isInternetVisible: false,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
}
const syntheticIdempotencyKey = /^synthetic:[0-9a-f-]{36}$/

function createCtx(
	overrides?: Partial<{
		executionOrigin: 'interactive' | 'background'
		storageContext: {
			packageId?: string | null
			appId?: string | null
			storageId?: string | null
		} | null
	}>,
) {
	mocks.resolvePackageOwnerContext.mockResolvedValue({
		ownerUserId: ownerIdFromStored('user-1'),
		ownerScope: 'user',
		ownerEmail: 'user@example.com',
		actorUserId: 'user-1',
	})
	return {
		env: { APP_DB: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			executionOrigin: overrides?.executionOrigin ?? 'interactive',
			user: {
				userId: ownerIdFromStored('user-1'),
				email: 'user@example.com',
				displayName: 'User',
			},
			storageContext: overrides?.storageContext ?? null,
			repoContext: null,
			request: sessionRequestContext('user-1'),
		},
	}
}

function dispatch(
	args: Record<string, unknown> = {},
	ctx: ReturnType<typeof createCtx> = createCtx(),
) {
	return packageSubscriptionDispatchCapability.handler(
		{
			kody_id: 'demo',
			topic: 'repo.pushed',
			params: { event: 'repo.pushed' },
			...args,
		},
		ctx as never,
	)
}

function mockDeclaredSubscription(topic = inboundEmailReceiptTopic) {
	mocks.resolveSavedPackageRef.mockResolvedValue(savedPackage)
	mocks.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: {
			name: '@user/demo',
			kody: {
				id: 'demo',
				description: 'Demo',
				subscriptions: { [topic]: { handler: './src/on-email.ts' } },
			},
		},
	})
}

function mockStoredEmail(
	id: string,
	classification: 'accepted' | 'quarantined',
) {
	mocks.getInternalEmailMessageById.mockResolvedValue({
		id,
		inboxId: 'inbox-1',
		fromAddress: 'sender@example.com',
		envelopeFrom: 'sender@example.com',
		toAddresses: ['user@inbox.example.com'],
		ccAddresses: [],
		replyToAddresses: [],
		subject: 'Hello',
		messageIdHeader: `<${id}@example.com>`,
		inReplyToHeader: null,
		references: [],
		processingStatus: 'received',
		classification,
		classificationReason: classification === 'accepted' ? null : 'test',
		receivedAt: '2026-01-01T00:00:00.000Z',
		createdAt: '2026-01-01T00:00:00.000Z',
	})
}

test('packageSubscriptionDispatch sends synthetic params envelopes to one package', async () => {
	mockDeclaredSubscription('repo.pushed')

	const result = await dispatch({
		params: { event: 'repo.pushed', synthetic: true, replay_of: 'forged' },
	})

	expect(result).toMatchObject({
		package_id: 'pkg-1',
		kody_id: 'demo',
		slug: 'demo',
		topic: 'repo.pushed',
		source: 'synthetic',
		synthetic: true,
		replay_of: null,
		status: 200,
	})
	expect(result.idempotency_key).toMatch(syntheticIdempotencyKey)
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage,
			topic: 'repo.pushed',
			trustedSyntheticDispatch: expect.any(Object),
			actorTokenId: 'internal:synthetic-subscriptions',
			params: { event: 'repo.pushed', synthetic: true },
			idempotencyKey: result.idempotency_key,
		}),
	)

	const second = await dispatch()
	expect(second.idempotency_key).toMatch(syntheticIdempotencyKey)
	expect(second.idempotency_key).not.toBe(result.idempotency_key)
})

test('packageSubscriptionDispatch bounds oversized handler results', async () => {
	mockDeclaredSubscription('repo.pushed')
	mocks.invokePackageSubscription.mockResolvedValue({
		status: 200,
		body: { result: { blob: 'x'.repeat(102_400) } },
	})

	expect((await dispatch()).result).toEqual({
		truncated: true,
		message:
			'Subscription result exceeded 102400 bytes and was omitted. Inspect the subscription run for details.',
	})
})

test('packageSubscriptionDispatch replays stored inbound email envelopes and rejects topic mismatches', async () => {
	mockDeclaredSubscription()
	mockStoredEmail('message-1', 'accepted')
	mocks.listInternalEmailAttachmentsForMessage.mockResolvedValue([
		{
			id: 'attachment-1',
			filename: 'note.txt',
			contentType: 'text/plain',
			contentId: null,
			disposition: null,
			size: 4,
			storageKind: 'blob',
			storageKey: 'blob-1',
			createdAt: '2026-01-01T00:00:00.000Z',
		},
	])
	const replay = { topic: inboundEmailReceiptTopic, params: undefined }

	const result = await dispatch({ ...replay, email_message_id: 'message-1' })

	expect(result).toMatchObject({
		source: 'synthetic',
		synthetic: true,
		replay_of: 'message-1',
	})
	expect(result.idempotency_key).toMatch(syntheticIdempotencyKey)
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			params: expect.objectContaining({
				event: inboundEmailReceiptTopic,
				synthetic: true,
				replay_of: 'message-1',
				message: expect.objectContaining({ id: 'message-1' }),
				attachments: [
					expect.objectContaining({ id: 'attachment-1', filename: 'note.txt' }),
				],
			}),
		}),
	)

	mocks.invokePackageSubscription.mockClear()
	mockStoredEmail('message-quarantined', 'quarantined')
	await expect(
		dispatch({ ...replay, email_message_id: 'message-quarantined' }),
	).rejects.toThrow(
		'would dispatch on topic "email.message.quarantined", not "email.message.received"',
	)
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()
})

test('packageSubscriptionDispatch rejects runtime callers and undeclared topics', async () => {
	mockDeclaredSubscription('repo.pushed')
	for (const ctx of [
		createCtx({
			storageContext: {
				packageId: 'pkg-1',
				appId: null,
				storageId: 'package:pkg-1',
			},
		}),
		createCtx({ executionOrigin: 'background' }),
	]) {
		await expect(dispatch({}, ctx)).rejects.toThrow(
			'packageSubscriptionDispatch is unavailable from package runtime contexts.',
		)
	}

	mockDeclaredSubscription()
	await expect(dispatch()).rejects.toThrow(/packageSubscriptionDispatch/)
})

test('packageSubscriptionDispatch resolves the package in the request org like packageGet', async () => {
	mockDeclaredSubscription('repo.pushed')
	const ctx = createCtx()
	mocks.resolvePackageOwnerContext.mockResolvedValue({
		ownerUserId: ownerIdFromStored('org-owner'),
		ownerScope: 'acme',
		ownerEmail: 'acme@example.com',
		actorUserId: 'user-1',
	})

	await dispatch({}, ctx)

	expect(mocks.resolvePackageOwnerContext).toHaveBeenCalledWith(ctx.env, {
		user: ctx.callerContext.user,
		request: ctx.callerContext.request,
	})
	expect(mocks.resolveSavedPackageRef).toHaveBeenCalledWith(ctx.env.APP_DB, {
		userId: ownerIdFromStored('org-owner'),
		ref: 'demo',
		match: 'slug',
	})
})
