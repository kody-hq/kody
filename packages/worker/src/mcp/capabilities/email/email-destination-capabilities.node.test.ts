import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as Destinations from '#worker/email/destinations.ts'
import { EmailDestinationError } from '#worker/email/destinations.ts'
import { identityEmailDestinationId } from '#universal/email-destinations.ts'

const mocks = vi.hoisted(() => ({
	removeEmailNotificationDestination: vi.fn(),
	loadEmailDestinationAccount: vi.fn(),
}))

vi.mock('#worker/email/destinations.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof Destinations>()
	return {
		...actual,
		removeEmailNotificationDestination:
			mocks.removeEmailNotificationDestination,
		loadEmailDestinationAccount: mocks.loadEmailDestinationAccount,
	}
})

const { emailDestinationRemoveCapability } =
	await import('./email-destination-remove.ts')

function createUsersDb() {
	return {
		prepare: () => ({
			bind: () => ({
				first: async () => ({ email_verified_at: '2026-01-01T00:00:00.000Z' }),
			}),
		}),
	} as unknown as D1Database
}

function createEnv() {
	return { APP_DB: createUsersDb() } as Env
}

function createUserContext() {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'owner@example.com',
			displayName: 'Owner',
		},
	})
}

test('emailDestinationRemove scopes the caller account and maps identity protection errors', async () => {
	const env = createEnv()
	mocks.loadEmailDestinationAccount.mockResolvedValue({
		id: 1,
		email: 'owner@example.com',
		emailVerifiedAt: '2026-01-01T00:00:00.000Z',
		stableUserId: ownerIdFromStored('user-1'),
	})

	const identityError = new EmailDestinationError(
		'cannot_remove_identity',
		'The account email stays on the destination list.',
	)
	mocks.removeEmailNotificationDestination.mockRejectedValueOnce(identityError)
	await expect(
		emailDestinationRemoveCapability.handler(
			{ id: identityEmailDestinationId },
			{ env, callerContext: createUserContext() },
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message.includes('The account email stays on the destination list'),
	)
	expect(mocks.loadEmailDestinationAccount).toHaveBeenCalledWith({
		db: env.APP_DB,
		stableUserId: ownerIdFromStored('user-1'),
	})
})
