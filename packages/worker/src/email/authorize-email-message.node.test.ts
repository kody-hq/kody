import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { type EmailMessageRecord } from './types.ts'

const supportInbox = 'inbox-support'
const billingInbox = 'inbox-billing'

const mocks = vi.hoisted(() => ({
	messages: new Map<string, { id: string; inboxId: string | null }>(),
	deleteEmailMessage: vi.fn(async () => true),
	setEmailMessageClassification: vi.fn(async () => ({ id: 'updated' })),
}))

vi.mock('./owner-email-reader.ts', () => ({
	getOwnerEmailMessageById: async (input: { messageId: string }) =>
		(mocks.messages.get(input.messageId) as EmailMessageRecord | undefined) ??
		null,
}))

vi.mock('./repo.ts', () => ({
	getEmailInboxById: async (input: { id: string }) => ({
		id: input.id,
		name: input.id === supportInbox ? 'support' : 'billing',
	}),
}))

vi.mock('./service.ts', () => ({
	deleteEmailMessage: mocks.deleteEmailMessage,
	setEmailMessageClassification: mocks.setEmailMessageClassification,
}))

vi.mock('#worker/identity/email-verification-state.ts', async (original) => ({
	...(await original<object>()),
	isAccountEmailVerified: async () => true,
}))

const { emailMessageDeleteCapability } =
	await import('#mcp/capabilities/email/email-message-delete.ts')
const { emailMessageClassifyCapability } =
	await import('#mcp/capabilities/email/email-message-classify.ts')
const { deleteAccountEmailMessage, classifyAccountEmailMessage } =
	await import('#app/handlers/account-email.ts')

const manage = [
	'email:read',
	'email:send',
	'email:write',
	'email:delete',
	'email:manage_access',
]

async function setup() {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	await ensureOrgsTestSchema(db)
	const ownerId = testStableUserIdFromEmail('owner@example.com')
	const orgSlug = `u${ownerId.slice(0, 8)}`
	await provisionPersonalOrg(db, { stableUserId: ownerId, username: orgSlug })
	const memberId = testStableUserIdFromEmail('member@example.com')
	const now = new Date().toISOString()
	const grantId = crypto.randomUUID()
	await db
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at
			) VALUES (?, ?, 'email', ?, 'user', ?, 'manage', ?, ?, ?)`,
		)
		.bind(grantId, ownerId, supportInbox, memberId, ownerId, now, now)
		.run()
	for (const permission of manage) {
		await db
			.prepare(
				`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
			)
			.bind(grantId, permission)
			.run()
	}
	const env = { APP_DB: db, AUDIT_DB: createAuditTestDb() } as unknown as Env
	function contextFor(userId: string, role: 'owner' | 'member') {
		return {
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://kody.example',
				user: {
					userId: personIdFromStored(userId),
					email: `${userId}@example.com`,
					displayName: 'Person',
				},
				orgBinding: {
					org: { id: ownerIdFromStored(ownerId), slug: orgSlug },
					role,
				},
			}),
		}
	}
	mocks.messages.clear()
	mocks.messages.set('msg-support', {
		id: 'msg-support',
		inboxId: supportInbox,
	})
	mocks.messages.set('msg-billing', {
		id: 'msg-billing',
		inboxId: billingInbox,
	})
	mocks.messages.set('msg-no-inbox', { id: 'msg-no-inbox', inboxId: null })
	mocks.deleteEmailMessage.mockClear()
	mocks.setEmailMessageClassification.mockClear()
	return {
		owner: contextFor(ownerId, 'owner'),
		member: contextFor(memberId, 'member'),
	}
}

function websiteUser(ctx: Awaited<ReturnType<typeof setup>>['member']) {
	const user = ctx.callerContext.user!
	return {
		env: ctx.env,
		user: {
			email: user.email,
			mcpUser: user,
			request: ctx.callerContext.request,
		} as unknown as Parameters<typeof deleteAccountEmailMessage>[0]['user'],
	}
}

test('emailMessageDelete and emailMessageClassify need the grant on the message inbox', async () => {
	const { member, owner } = await setup()

	await expect(
		emailMessageDeleteCapability.handler({ message_id: 'msg-support' }, member),
	).resolves.toEqual({ deleted: true, message_id: 'msg-support' })
	await expect(
		emailMessageClassifyCapability.handler(
			{ message_id: 'msg-support', archived: true },
			member,
		),
	).resolves.toMatchObject({ message_id: 'msg-support', archived: true })

	await expect(
		emailMessageDeleteCapability.handler({ message_id: 'msg-billing' }, member),
	).rejects.toThrow('Missing email:delete on email inbox "billing".')
	await expect(
		emailMessageClassifyCapability.handler(
			{ message_id: 'msg-billing', classification: 'spam' },
			member,
		),
	).rejects.toThrow('Missing email:write on email inbox "billing".')
	await expect(
		emailMessageDeleteCapability.handler(
			{ message_id: 'msg-no-inbox' },
			member,
		),
	).rejects.toBeInstanceOf(AuthorizationError)
	expect(mocks.deleteEmailMessage).toHaveBeenCalledTimes(1)
	expect(mocks.setEmailMessageClassification).toHaveBeenCalledTimes(1)

	await emailMessageDeleteCapability.handler(
		{ message_id: 'msg-billing' },
		owner,
	)
	await emailMessageDeleteCapability.handler(
		{ message_id: 'msg-no-inbox' },
		owner,
	)
	expect(mocks.deleteEmailMessage).toHaveBeenCalledTimes(3)
})

test('website Delete and Classify/Archive need the grant on the message inbox', async () => {
	const { member } = await setup()
	const ctx = websiteUser(member)

	const deleted = await deleteAccountEmailMessage({
		...ctx,
		messageId: 'msg-support',
	})
	expect(deleted.status).toBe(200)
	const archived = await classifyAccountEmailMessage({
		...ctx,
		messageId: 'msg-support',
		archived: true,
	})
	expect(archived.status).toBe(200)

	await expect(
		deleteAccountEmailMessage({ ...ctx, messageId: 'msg-billing' }),
	).rejects.toThrow('Missing email:delete on email inbox "billing".')
	await expect(
		classifyAccountEmailMessage({
			...ctx,
			messageId: 'msg-billing',
			classification: 'spam',
		}),
	).rejects.toThrow('Missing email:write on email inbox "billing".')
	await expect(
		classifyAccountEmailMessage({
			...ctx,
			messageId: 'msg-billing',
			archived: true,
		}),
	).rejects.toBeInstanceOf(AuthorizationError)
	expect(mocks.deleteEmailMessage).toHaveBeenCalledTimes(1)
	expect(mocks.setEmailMessageClassification).toHaveBeenCalledTimes(1)

	const missing = await deleteAccountEmailMessage({
		...ctx,
		messageId: 'msg-gone',
	})
	expect(missing.status).toBe(404)
})
