import { expect, test, vi } from 'vitest'
import {
	mcpOAuthGrantMaxAgeSeconds,
	mcpOAuthMaxGrantsPerUserClient,
	pruneUserClientOAuthGrants,
	selectOAuthGrantsToPrune,
} from '#worker/oauth-grant-prune.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'

function grant(
	id: string,
	createdAt: number,
	clientId = 'https://chatgpt.com/oauth/client.json',
) {
	return { id, clientId, scope: ['profile', 'email'], createdAt }
}

test('selectOAuthGrantsToPrune keeps the newest N and marks older excess', () => {
	const nowSeconds = 1_700_000_000
	const grants = Array.from({ length: 12 }, (_, index) =>
		grant(`grant-${index}`, nowSeconds - index * 60),
	)

	expect(
		selectOAuthGrantsToPrune({
			grants,
			nowSeconds,
			maxGrants: mcpOAuthMaxGrantsPerUserClient,
		}),
	).toEqual([
		{ id: 'grant-10', reason: 'excess' },
		{ id: 'grant-11', reason: 'excess' },
	])
})

test('selectOAuthGrantsToPrune revokes stale grants even under the N cap', () => {
	const nowSeconds = 1_700_000_000
	const fresh = grant('fresh', nowSeconds - 60)
	const stale = grant('stale', nowSeconds - mcpOAuthGrantMaxAgeSeconds - 1)

	expect(
		selectOAuthGrantsToPrune({
			grants: [fresh, stale],
			nowSeconds,
			maxGrants: mcpOAuthMaxGrantsPerUserClient,
		}),
	).toEqual([{ id: 'stale', reason: 'stale' }])
})

test('selectOAuthGrantsToPrune never revokes keepGrantIds', () => {
	const nowSeconds = 1_700_000_000
	// grant-0 newest … grant-11 oldest. Keeping grant-11 (would otherwise be
	// excess) leaves 11 candidates for a cap of 10, so grant-10 is excess.
	const grants = Array.from({ length: 12 }, (_, index) =>
		grant(`grant-${index}`, nowSeconds - index * 60),
	)

	expect(
		selectOAuthGrantsToPrune({
			grants,
			nowSeconds,
			maxGrants: 10,
			keepGrantIds: new Set(['grant-11']),
		}),
	).toEqual([{ id: 'grant-10', reason: 'excess' }])
})

test('pruneUserClientOAuthGrants revokes selected grants and audits once', async () => {
	const nowSeconds = 1_700_000_000
	const revoked: Array<string> = []
	const helpers = {
		listUserGrants: async () => ({
			items: [
				grant('keep-new', nowSeconds),
				grant('keep-2', nowSeconds - 10),
				grant('excess-old', nowSeconds - 20),
				grant('stale', nowSeconds - mcpOAuthGrantMaxAgeSeconds - 5),
			],
		}),
		revokeGrant: vi.fn(async (grantId: string, userId: string) => {
			expect(userId).toBe('user-1')
			revoked.push(grantId)
		}),
	}

	await expect(
		pruneUserClientOAuthGrants({
			helpers,
			userId: 'user-1',
			clientId: 'https://chatgpt.com/oauth/client.json',
			env: {},
			nowSeconds,
			maxGrants: 2,
		}),
	).resolves.toEqual({ revoked: 2, stale: 1, excess: 1 })

	expect(revoked.sort()).toEqual(['excess-old', 'stale'])
	expect(helpers.revokeGrant).toHaveBeenCalledTimes(2)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'oauth',
			action: 'connection_pruned',
			result: 'success',
			clientId: 'https://chatgpt.com/oauth/client.json',
			reason: 'revoked=2;stale=1;excess=1',
		}),
	)
})

test('pruneUserClientOAuthGrants is best-effort when listing fails', async () => {
	const helpers = {
		listUserGrants: async () => {
			throw new Error('kv unavailable')
		},
		revokeGrant: vi.fn(async () => undefined),
	}

	await expect(
		pruneUserClientOAuthGrants({
			helpers,
			userId: 'user-1',
			clientId: 'client-a',
			env: {},
		}),
	).resolves.toEqual({ revoked: 0, stale: 0, excess: 0 })

	expect(helpers.revokeGrant).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'oauth',
			action: 'connection_pruned',
			result: 'failure',
			clientId: 'client-a',
			reason: 'prune_failed',
		}),
	)
})
