import { setAuthSessionSecret } from '#app/auth-session.ts'
import { accountDeletionConfirmationPhrase } from '#universal/account-deletion-confirmation.ts'
import { UserDeleteBlockedSoleOwnerError } from '#worker/orgs/soft-delete.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeAll, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUserForDeletion: vi.fn(),
	softDeleteUserAccount: vi.fn(),
	scheduleUserDeletedEvent: vi.fn(),
	findOne: vi.fn(),
	verifyPassword: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUserForDeletion: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUserForDeletion(...args),
}))

vi.mock('#worker/orgs/soft-delete.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/orgs/soft-delete.ts')>()
	return {
		...actual,
		softDeleteUserAccount: (...args: Array<unknown>) =>
			mocks.softDeleteUserAccount(...args),
	}
})

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: vi.fn(),
	scheduleUserDeletedEvent: (...args: Array<unknown>) =>
		mocks.scheduleUserDeletedEvent(...args),
}))

vi.mock('#worker/db.ts', () => ({
	createDb: () => ({
		findOne: (...args: Array<unknown>) => mocks.findOne(...args),
	}),
	usersTable: {},
}))

vi.mock('@kody-internal/shared/password-hash.ts', () => ({
	verifyPassword: (...args: Array<unknown>) => mocks.verifyPassword(...args),
}))

const { testAccountDeleteHandler } =
	await import('./account-delete.test-support.ts')

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const signedInUser = {
	userId: 7,
	username: 'ada',
	email: 'ada@example.com',
	mcpUser: { userId: ownerIdFromStored('stable-ada') },
}

function createHandler() {
	return testAccountDeleteHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: {} as D1Database,
		APP_BASE_URL: 'https://kody.example',
	} as Env)
}

async function requestDelete(body: unknown) {
	const request = new Request('https://example.com/account/delete', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
	return createHandler().execute({ request: request } as never)
}

function signInOauthOnlyUser() {
	mocks.readAuthenticatedAppUserForDeletion.mockResolvedValue(signedInUser)
	mocks.findOne.mockResolvedValue({
		id: 7,
		password_hash: 'oauth_created_no_usable_password',
	})
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('account deletion requires GOODBYE KODY, password when one exists, and soft-deletes', async () => {
	mocks.readAuthenticatedAppUserForDeletion.mockResolvedValueOnce(null)
	const unauthenticated = await requestDelete({
		confirmation: accountDeletionConfirmationPhrase,
	})
	expect(unauthenticated.status).toBe(401)

	mocks.readAuthenticatedAppUserForDeletion.mockResolvedValue(signedInUser)
	mocks.findOne.mockResolvedValue({
		id: 7,
		password_hash: 'pbkdf2_sha256$100000$salt$hash',
	})
	mocks.verifyPassword.mockResolvedValue(false)
	mocks.softDeleteUserAccount.mockResolvedValue({
		userId: ownerIdFromStored('stable-ada'),
		deletedAt: '2026-10-01T12:00:00.000Z',
		deletedOrgIds: ['stable-ada'],
	})

	const rejections = [
		[{ password: 'secret' }, 400],
		[{ confirmation: 'goodbye kody', password: 'secret' }, 400],
		[{ confirmation: accountDeletionConfirmationPhrase }, 400],
		[
			{ confirmation: accountDeletionConfirmationPhrase, password: 'nope' },
			401,
		],
	] as const
	for (const [body, status] of rejections) {
		expect([body, (await requestDelete(body)).status]).toEqual([body, status])
	}
	expect(mocks.softDeleteUserAccount).not.toHaveBeenCalled()

	mocks.verifyPassword.mockResolvedValue(true)
	const deleted = await requestDelete({
		confirmation: `  ${accountDeletionConfirmationPhrase}  `,
		password: 'secret',
	})
	expect(deleted.status).toBe(200)
	expect(deleted.data).toMatchObject({
		ok: true,
		softDeleted: true,
		restoreWindowDays: 30,
		userId: ownerIdFromStored('stable-ada'),
		deletedOrgIds: ['stable-ada'],
	})
	expect(new Headers(deleted.headers).get('Set-Cookie') ?? '').toContain(
		'kody_session=',
	)
	expect(mocks.softDeleteUserAccount).toHaveBeenCalledWith({
		env: expect.objectContaining({ COOKIE_SECRET: testCookieSecret }),
		userId: ownerIdFromStored('stable-ada'),
		actorUserId: 'stable-ada',
		actorUsername: 'ada',
	})
	expect(mocks.scheduleUserDeletedEvent).toHaveBeenCalledWith({
		env: expect.objectContaining({ COOKIE_SECRET: testCookieSecret }),
		user: {
			id: 'stable-ada',
			username: 'ada',
			email: 'ada@example.com',
		},
	})

	mocks.findOne.mockResolvedValue({
		id: 7,
		password_hash: 'oauth_created_no_usable_password',
	})
	mocks.softDeleteUserAccount.mockClear()
	mocks.scheduleUserDeletedEvent.mockClear()
	const oauthDeleted = await requestDelete({
		confirmation: accountDeletionConfirmationPhrase,
	})
	expect(oauthDeleted.status).toBe(200)
	expect(mocks.verifyPassword).toHaveBeenCalledTimes(2)
	expect(mocks.softDeleteUserAccount).toHaveBeenCalledOnce()
	expect(mocks.scheduleUserDeletedEvent).toHaveBeenCalledOnce()

	expect(auditEventSummaries()).toEqual([
		'account_delete:failure',
		'account_delete:failure',
		'account_delete:failure',
		'account_delete:success',
		'account_delete:success',
	])
})

test('sole Owner of an org with other members is blocked with a 409', async () => {
	signInOauthOnlyUser()
	mocks.softDeleteUserAccount.mockRejectedValueOnce(
		new UserDeleteBlockedSoleOwnerError([
			{ orgId: ownerIdFromStored('org-acme'), orgSlug: 'acme' },
		]),
	)

	const response = await requestDelete({
		confirmation: accountDeletionConfirmationPhrase,
	})

	expect(response.status).toBe(409)
	expect(response.data).toEqual({
		error:
			'Account deletion is blocked while you are the only Owner of @acme. Promote another Owner or remove the other members first.',
		blockers: [{ orgId: ownerIdFromStored('org-acme'), orgSlug: 'acme' }],
	})
	expect(new Headers(response.headers).get('Set-Cookie')).toBeNull()
	expect(mocks.scheduleUserDeletedEvent).not.toHaveBeenCalled()
	expect(auditEventSummaries()).toEqual(['account_delete:failure'])
	expect(logAuditEventSpy.mock.calls.at(-1)?.[0]).toMatchObject({
		action: 'account_delete',
		result: 'failure',
		reason: 'sole_owner_with_members',
	})
})

test('a successful soft deletion reports restore window metadata', async () => {
	signInOauthOnlyUser()
	mocks.softDeleteUserAccount.mockResolvedValueOnce({
		userId: ownerIdFromStored('stable-ada'),
		deletedAt: '2026-10-01T12:00:00.000Z',
		deletedOrgIds: ['stable-ada', 'org-side'],
	})

	const softDeleted = await requestDelete({
		confirmation: accountDeletionConfirmationPhrase,
	})
	expect(softDeleted.status).toBe(200)
	const body = softDeleted.data
	expect(body).toMatchObject({
		ok: true,
		softDeleted: true,
		restoreWindowDays: 30,
		deletedOrgIds: ['stable-ada', 'org-side'],
	})
	expect(body).not.toHaveProperty('refunds')
})
