import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { systemEmailOwnerId } from './email-owner.ts'

const mocks = vi.hoisted(() => ({
	setMessageClassification: vi.fn(),
	updateSystemEmailMessageClassification: vi.fn(),
}))

vi.mock('./mailbox-client.ts', () => ({
	mailboxRpc: () => ({
		setMessageClassification: mocks.setMessageClassification,
	}),
}))

vi.mock('./system-email-graph-store.ts', () => ({
	updateSystemEmailMessageClassification:
		mocks.updateSystemEmailMessageClassification,
}))

const { setEmailMessageClassification } = await import('./service.ts')

function createEnv() {
	const first = vi.fn(async () => ({
		owner_count: 1,
		frozen_at: '2026-08-03T00:00:00.000Z',
		max_parity_age_hours: 6,
	}))
	const prepare = vi.fn(() => ({ first }))
	const env = {
		APP_DB: { prepare } as unknown as D1Database,
	} as Env
	return { env }
}

test('setEmailMessageClassification mutates the owner Mailbox', async () => {
	const { env } = createEnv()
	mocks.setMessageClassification.mockResolvedValue({
		status: 'accepted',
	})

	await expect(
		setEmailMessageClassification({
			env,
			db: env.APP_DB,
			userId: ownerIdFromStored('user-1'),
			messageId: 'message-1',
			classification: 'quarantined',
			classificationReason: 'Reclassified by user.',
		}),
	).resolves.toBe(true)

	expect(mocks.setMessageClassification).toHaveBeenCalledWith({
		ownerId: ownerIdFromStored('user-1'),
		messageId: 'message-1',
		classification: 'quarantined',
		classificationReason: 'Reclassified by user.',
		updatedAt: expect.any(String),
	})
})

test('setEmailMessageClassification preserves the dedicated system graph path', async () => {
	const { env } = createEnv()
	mocks.updateSystemEmailMessageClassification.mockResolvedValueOnce(true)

	await expect(
		setEmailMessageClassification({
			env,
			db: env.APP_DB,
			userId: systemEmailOwnerId,
			messageId: 'message-1',
			classification: 'quarantined',
			classificationReason: 'Reclassified by user.',
		}),
	).resolves.toBe(true)

	expect(mocks.updateSystemEmailMessageClassification).toHaveBeenCalledWith({
		db: env.APP_DB,
		messageId: 'message-1',
		classification: 'quarantined',
		classificationReason: 'Reclassified by user.',
		now: expect.any(String),
	})
})

test('setEmailMessageClassification stamps or clears archived_at on the owner Mailbox', async () => {
	const { env } = createEnv()
	mocks.setMessageClassification.mockResolvedValue({ status: 'accepted' })
	const now = '2026-08-04T00:00:00.000Z'

	await expect(
		setEmailMessageClassification({
			env,
			db: env.APP_DB,
			userId: ownerIdFromStored('user-1'),
			messageId: 'message-1',
			archived: true,
			now,
		}),
	).resolves.toBe(true)
	expect(mocks.setMessageClassification).toHaveBeenLastCalledWith({
		ownerId: ownerIdFromStored('user-1'),
		messageId: 'message-1',
		archivedAt: now,
		updatedAt: now,
	})

	await setEmailMessageClassification({
		env,
		db: env.APP_DB,
		userId: ownerIdFromStored('user-1'),
		messageId: 'message-1',
		classification: 'spam',
		classificationReason: 'Marked as spam.',
		archived: false,
		now,
	})
	expect(mocks.setMessageClassification).toHaveBeenLastCalledWith({
		ownerId: ownerIdFromStored('user-1'),
		messageId: 'message-1',
		classification: 'spam',
		classificationReason: 'Marked as spam.',
		archivedAt: null,
		updatedAt: now,
	})

	mocks.setMessageClassification.mockResolvedValueOnce({ status: 'missing' })
	await expect(
		setEmailMessageClassification({
			env,
			db: env.APP_DB,
			userId: ownerIdFromStored('user-1'),
			messageId: 'missing',
			classification: 'spam',
		}),
	).resolves.toBe(false)

	await expect(
		setEmailMessageClassification({
			env,
			db: env.APP_DB,
			userId: ownerIdFromStored('user-1'),
			messageId: 'message-1',
		}),
	).rejects.toThrow('requires classification or archived')
})

test('setEmailMessageClassification forwards archive to the system graph', async () => {
	const { env } = createEnv()
	mocks.updateSystemEmailMessageClassification.mockResolvedValueOnce(true)
	await setEmailMessageClassification({
		env,
		db: env.APP_DB,
		userId: systemEmailOwnerId,
		messageId: 'message-1',
		archived: true,
		now: '2026-08-04T00:00:00.000Z',
	})
	expect(mocks.updateSystemEmailMessageClassification).toHaveBeenLastCalledWith(
		{
			db: env.APP_DB,
			messageId: 'message-1',
			classification: undefined,
			classificationReason: undefined,
			archived: true,
			now: '2026-08-04T00:00:00.000Z',
		},
	)
})
