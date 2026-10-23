import { expect, test, vi } from 'vitest'
import type * as OwnerEmails from '#worker/orgs/owner-emails.ts'
import type * as SendPolicy from '#worker/email/transactional-send-policy.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const loadOrgOwnerRecipientEmails = vi.fn<
	typeof OwnerEmails.loadOrgOwnerRecipientEmails
>(async () => [{ userId: 'person-1', email: 'owner@example.com' }])
const sendGatedTransactionalEmail = vi.fn<
	typeof SendPolicy.sendGatedTransactionalEmail
>(async () => ({ ok: true }))

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

const { notifyOwnersOfJobAutoDisabled } =
	await import('./job-auto-disabled-notice.ts')

const env = {
	APP_DB: {},
	APP_BASE_URL: 'https://kody.codes/',
	CLOUDFLARE_ACCOUNT_ID: 'acct',
	CLOUDFLARE_API_TOKEN: 'token',
} as unknown as Env

const notice = {
	env,
	ownerId: 'org-1',
	jobId: 'job-1',
	jobName: 'daily-refresh',
	reason: 'Kody could not compute the next run from the job schedule.',
}

test('a scheduler auto-disable emails each owner the job and the reason', async () => {
	consoleWarn.mockImplementation(() => {})
	await expect(notifyOwnersOfJobAutoDisabled(notice)).resolves.toEqual({
		recipients: 1,
		delivered: 1,
	})
	expect(loadOrgOwnerRecipientEmails).toHaveBeenCalledWith(env.APP_DB, 'org-1')
	const sent = sendGatedTransactionalEmail.mock.calls[0]?.[0]
	expect(sent).toMatchObject({
		kind: 'job_auto_disabled',
		category: 'holdable',
		message: {
			to: 'owner@example.com',
			subject: 'Kody turned off your job "daily-refresh"',
		},
	})
	expect(sent?.message.text).toContain(notice.reason)
	expect(sent?.message.text).toContain('https://kody.codes/@acme/-/jobs')
	expect(consoleWarn).toHaveBeenCalledWith('job-auto-disabled', {
		ownerId: 'org-1',
		jobId: 'job-1',
		reason: notice.reason,
	})
})

test('a failed auto-disable notice never throws into the scheduler', async () => {
	consoleWarn.mockImplementation(() => {})
	sendGatedTransactionalEmail.mockRejectedValueOnce(new Error('send down'))
	await expect(notifyOwnersOfJobAutoDisabled(notice)).resolves.toEqual({
		recipients: 1,
		delivered: 0,
	})
	loadOrgOwnerRecipientEmails.mockRejectedValueOnce(new Error('D1 down'))
	await expect(notifyOwnersOfJobAutoDisabled(notice)).resolves.toEqual({
		recipients: 0,
		delivered: 0,
	})
})
