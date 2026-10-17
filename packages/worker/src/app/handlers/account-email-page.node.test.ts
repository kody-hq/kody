import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as EmailDestinations from '#worker/email/destinations.ts'
import {
	loadEmailList,
	loadEmailDestinations,
} from '../../../start/server/email.ts'
import { readAccountEmailData } from '#app/account-email-data.ts'
import {
	listEmailNotificationDestinations,
	maxAdditionalEmailNotificationDestinations,
} from '#worker/email/destinations.ts'
import { identityEmailDestinationId } from '#universal/email-destinations.ts'

const state = vi.hoisted(() => ({
	collection: vi.fn(),
	authenticate: vi.fn(),
	env: { APP_DB: {}, SENTRY_ENVIRONMENT: 'test' },
	request: new Request('https://example.com/_serverFn/read'),
}))
vi.mock(
	'../../../start/server/collection-context.ts',
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import('../../../start/server/collection-context.ts')
		>()),
		loadScopedCollection: state.collection,
	}),
)
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	env: state.env,
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => state.request,
	setResponseHeader: vi.fn(),
}))
vi.mock('#app/env.ts', () => ({ getEnv: () => state.env }))
vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: state.authenticate,
}))

vi.mock('#app/account-email-data.ts', () => ({
	readAccountEmailData: vi.fn(),
}))

vi.mock('#worker/email/destinations.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EmailDestinations>()
	return {
		...actual,
		listEmailNotificationDestinations: vi.fn(),
	}
})

vi.mock('@tanstack/react-start', async () => ({
	createServerFn: (
		await import('#worker/test-support/start-server-function.ts')
	).createTestServerFn,
	createServerOnlyFn: <T>(fn: T) => fn,
}))
test('email server resources return independent message lists and actor destinations', async () => {
	const user = {
		sessionUserId: '42',
		userId: 42,
		username: 'test-user',
		email: 'user@example.com',
		emailVerified: true,
		displayName: 'user',
		roles: ['user'],
		permissions: [],
		artifactOwnerIds: [],
		mcpUser: {
			userId: ownerIdFromStored('stable-user-1'),
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'user',
		},
	}
	state.authenticate.mockResolvedValue(user)
	vi.mocked(readAccountEmailData).mockResolvedValue({
		ok: true,
		emailVerified: true,
		email: 'user@example.com',
		username: 'test-user',
		inboxAddress: 'test-user@inbox.example.com',
		verificationMessage: null,
		outboundDeliveryPausedAt: null,
		inboxes: [],
		messages: [],
		selectedMessage: null,
		usage: null,
		page: 1,
		pageSize: 25,
		total: 0,
		query: '',
		classification: null,
	})
	vi.mocked(listEmailNotificationDestinations).mockResolvedValue([
		{
			id: identityEmailDestinationId,
			email: 'user@example.com',
			kind: 'identity',
			verified: true,
			isDefault: true,
			canRemove: false,
		},
	])

	const [payload, destinations] = await Promise.all([
		loadEmailList({
			data: {
				org: null,
				query: '',
				classification: null,
				page: 1,
				pageSize: 25,
			},
		}),
		loadEmailDestinations(),
	])
	expect(state.authenticate).toHaveBeenCalledWith(state.request, state.env, {
		redirectTo: '/account/email?q=&page=1&pageSize=25',
	})
	expect(state.authenticate).toHaveBeenCalledWith(state.request, state.env, {
		redirectTo: '/account/email',
	})
	expect(listEmailNotificationDestinations).toHaveBeenCalledWith(
		expect.objectContaining({
			dbUserId: 42,
			accountEmail: 'user@example.com',
			accountEmailVerified: true,
		}),
	)
	const response = { payload, destinations }
	expect(response.payload).not.toHaveProperty('selectedMessage')
	expect(response).toMatchObject({
		payload: expect.objectContaining({
			ok: true,
			email: 'user@example.com',
		}),
		destinations: {
			ok: true,
			destinations: [
				expect.objectContaining({
					id: identityEmailDestinationId,
					email: 'user@example.com',
				}),
			],
			additionalLimit: maxAdditionalEmailNotificationDestinations,
			additionalRemaining: maxAdditionalEmailNotificationDestinations,
		},
	})
})

test('org inbox passes explicit filters and never derives selection from a request URL', async () => {
	state.collection.mockResolvedValue({
		bindings: { APP_DB: {} },
		user: { userId: 42 },
		request: new Request('https://example.com/_serverFn/read?selected=other'),
	})
	vi.mocked(readAccountEmailData).mockResolvedValue({
		selectedMessage: null,
	} as Awaited<ReturnType<typeof readAccountEmailData>>)
	await loadEmailList({
		data: {
			org: 'team',
			query: ' subject ',
			classification: 'quarantined',
			page: 3,
			pageSize: 50,
		},
	})
	expect(state.collection).toHaveBeenLastCalledWith({
		orgSlug: 'team',
		section: 'email',
		returnTo:
			'/@team/-/email?q=subject&page=3&pageSize=50&classification=quarantined',
	})
	expect(readAccountEmailData).toHaveBeenLastCalledWith({
		env: { APP_DB: {} },
		user: { userId: 42 },
		query: 'subject',
		classification: 'quarantined',
		page: 3,
		pageSize: 50,
	})
})
