import { expect, test, vi } from 'vitest'
import type * as OwnerEmails from '#worker/orgs/owner-emails.ts'
import type * as SendPolicy from '#worker/email/transactional-send-policy.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type { HeldForApproval } from './held-for-approval.ts'

const loadOrgOwnerRecipientEmails = vi.fn<
	typeof OwnerEmails.loadOrgOwnerRecipientEmails
>(async () => [{ userId: 'person-1', email: 'owner@example.com' }])
const sendGatedTransactionalEmail = vi.fn<
	typeof SendPolicy.sendGatedTransactionalEmail
>(async () => ({ ok: true }))
const loadHeldForApproval = vi.fn(
	async (_input: unknown): Promise<HeldForApproval | null> => ({
		servingCommit: 'aaaaaaa1111111111111',
		heldCommit: 'bbbbbbb2222222222222',
	}),
)

vi.mock('#worker/orgs/owner-emails.ts', () => ({
	loadOrgOwnerRecipientEmails: (
		...args: Parameters<typeof OwnerEmails.loadOrgOwnerRecipientEmails>
	) => loadOrgOwnerRecipientEmails(...args),
	loadOrgSlug: async () => 'acme',
	loadOrgUsernameFallback: async () => null,
}))

vi.mock('#worker/email/transactional-send-policy.ts', () => ({
	sendGatedTransactionalEmail: (
		...args: Parameters<typeof SendPolicy.sendGatedTransactionalEmail>
	) => sendGatedTransactionalEmail(...args),
}))

vi.mock('./held-for-approval.ts', () => ({
	loadHeldForApproval: (input: unknown) => loadHeldForApproval(input),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: async () => ({
		id: 'pkg-site',
		name: '@acme/site',
		kodyId: 'site',
	}),
}))

const { notifyOwnersOfHeldPublish } =
	await import('./held-for-approval-notice.ts')

const env = {
	APP_DB: {},
	APP_BASE_URL: 'https://kody.codes/',
	CLOUDFLARE_ACCOUNT_ID: 'acct',
	CLOUDFLARE_API_TOKEN: 'token',
} as unknown as Env

const notice = { env, ownerUserId: 'org-1', packageId: 'pkg-site' }

test('a held publish emails each owner the serving commit, the held commit, and how to approve', async () => {
	await expect(notifyOwnersOfHeldPublish(notice)).resolves.toEqual({
		recipients: 1,
		delivered: 1,
	})
	expect(loadOrgOwnerRecipientEmails).toHaveBeenCalledWith(env.APP_DB, 'org-1')
	const sent = sendGatedTransactionalEmail.mock.calls[0]?.[0]
	expect(sent).toMatchObject({
		kind: 'publish_held_for_approval',
		category: 'holdable',
		message: {
			to: 'owner@example.com',
			subject: '@acme/site has a publish waiting for your approval',
		},
	})
	const text = sent?.message.text ?? ''
	expect(text).toContain('Live now: commit aaaaaaa.')
	expect(text).toContain('Held: commit bbbbbbb.')
	expect(text).toContain('https://kody.codes/@acme/site/approve-capabilities')
	expect(text).not.toContain('\u2014')
})

test('a publish that is no longer held sends nothing', async () => {
	sendGatedTransactionalEmail.mockClear()
	loadHeldForApproval.mockResolvedValueOnce(null)
	await expect(notifyOwnersOfHeldPublish(notice)).resolves.toEqual({
		recipients: 0,
		delivered: 0,
	})
	expect(sendGatedTransactionalEmail).not.toHaveBeenCalled()
})

test('a failed held-publish notice never throws into the serving update', async () => {
	consoleWarn.mockImplementation(() => {})
	sendGatedTransactionalEmail.mockRejectedValueOnce(new Error('send down'))
	await expect(notifyOwnersOfHeldPublish(notice)).resolves.toEqual({
		recipients: 1,
		delivered: 0,
	})
	loadHeldForApproval.mockRejectedValueOnce(new Error('D1 down'))
	await expect(notifyOwnersOfHeldPublish(notice)).resolves.toEqual({
		recipients: 0,
		delivered: 0,
	})
})
