import { expect, test, vi } from 'vitest'
import type * as OwnerEmails from '#worker/orgs/owner-emails.ts'
import type * as SendPolicy from '#worker/email/transactional-send-policy.ts'
import { type PackageAppCustomHostnameRow } from './types.ts'

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

const { notifyOwnersOfCustomHostnameStatus } =
	await import('./status-notice.ts')

const db = {
	prepare: () => ({
		bind: () => ({
			first: async () => ({ user_id: 'org-1', kody_id: 'demo' }),
		}),
	}),
} as unknown as D1Database

const env = {
	APP_DB: db,
	APP_BASE_URL: 'https://kody.codes/',
	CLOUDFLARE_ACCOUNT_ID: 'acct',
	CLOUDFLARE_API_TOKEN: 'token',
} as unknown as Env

const row: PackageAppCustomHostnameRow = {
	id: 'row-1',
	hostname: 'apps.example.com',
	bindingKind: 'app',
	packageId: 'pkg-1',
	orgId: null,
	cloudflareHostnameId: 'cf-1',
	cloudflareZoneId: 'zone',
	hostnameStatus: 'active',
	sslStatus: 'active',
	verifiedAt: '2026-10-20T12:00:00.000Z',
	dnsMissingSince: null,
	ownershipVerification: null,
	sslValidationRecords: [],
	verificationErrors: [],
	checkWindowStartedAt: null,
	needsAttentionAt: null,
	createdByUserId: 'person-1',
	createdAt: '2026-10-20T11:58:00.000Z',
	updatedAt: '2026-10-20T12:00:00.000Z',
}

test('an app hostname going live emails the package owners with a link to the app', async () => {
	sendGatedTransactionalEmail.mockClear()
	await expect(
		notifyOwnersOfCustomHostnameStatus({ env, row, event: 'active' }),
	).resolves.toEqual({ recipients: 1, delivered: 1 })
	expect(loadOrgOwnerRecipientEmails).toHaveBeenCalledWith(db, 'org-1')
	const sent = sendGatedTransactionalEmail.mock.calls[0]?.[0]
	expect(sent).toMatchObject({
		kind: 'custom_domain_status',
		category: 'holdable',
		message: {
			to: 'owner@example.com',
			subject: 'Your custom domain apps.example.com is live',
		},
	})
	expect(sent?.message.text).toContain('https://apps.example.com/')
	expect(sent?.message.text).toContain('the app demo')
})

test('a stalled hostname email gives the reason and links to the package settings', async () => {
	sendGatedTransactionalEmail.mockClear()
	await notifyOwnersOfCustomHostnameStatus({
		env,
		row: {
			...row,
			hostnameStatus: 'pending',
			sslStatus: 'pending_validation',
			verifiedAt: null,
			needsAttentionAt: '2026-10-22T12:00:00.000Z',
			verificationErrors: ['custom hostname does not CNAME to this zone.'],
		},
		event: 'needs_attention',
	})
	const sent = sendGatedTransactionalEmail.mock.calls[0]?.[0]
	expect(sent?.message.subject).toBe(
		'Your custom domain apps.example.com needs attention',
	)
	expect(sent?.message.text).toContain(
		'custom hostname does not CNAME to this zone.',
	)
	expect(sent?.message.text).toContain('https://kody.codes/@acme/demo/settings')
})

test('a failed notice never throws', async () => {
	const { consoleWarn } = await import('#worker/test-support/console-spies.ts')
	consoleWarn.mockImplementation(() => {})
	sendGatedTransactionalEmail.mockRejectedValueOnce(new Error('send down'))
	await expect(
		notifyOwnersOfCustomHostnameStatus({ env, row, event: 'active' }),
	).resolves.toEqual({ recipients: 1, delivered: 0 })
})
