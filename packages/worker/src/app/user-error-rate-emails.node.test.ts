import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as cloudflareEmail from '#app/email/cloudflare-email.ts'
import type * as packageRepo from '#worker/package-registry/repo.ts'
import type * as runRecordsService from '#worker/run-records/service.ts'

const sendCloudflareEmail = vi.fn<typeof cloudflareEmail.sendCloudflareEmail>(
	async () => ({ ok: true }),
)

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (
		...args: Parameters<typeof cloudflareEmail.sendCloudflareEmail>
	) => sendCloudflareEmail(...args),
}))

const listRunRecords = vi.fn<typeof runRecordsService.listRunRecords>(
	async () => ({ runs: [], nextCursor: null }),
)

vi.mock('#worker/run-records/service.ts', () => ({
	listRunRecords: (
		...args: Parameters<typeof runRecordsService.listRunRecords>
	) => listRunRecords(...args),
}))

const getSavedPackageByIdInAnyOrg = vi.fn<
	typeof packageRepo.getSavedPackageByIdInAnyOrg
>(async () => null)

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageByIdInAnyOrg: (
		...args: Parameters<typeof packageRepo.getSavedPackageByIdInAnyOrg>
	) => getSavedPackageByIdInAnyOrg(...args),
}))

const {
	sendUserErrorRateEmails,
	shouldSendUserErrorRateEmail,
	summarizeRunError,
	userErrorRateEmailKvKey,
	userErrorRateMinErrors,
} = await import('#app/user-error-rate-emails.ts')

function createKv() {
	const store = new Map<string, string>()
	return {
		store,
		kv: {
			async get(key: string) {
				return store.get(key) ?? null
			},
			async put(key: string, value: string) {
				store.set(key, value)
			},
		} as unknown as KVNamespace,
	}
}

function createEnv(input: {
	users: Array<{
		stable_user_id: string
		org_id?: string
		email: string
		event_count: number
		error_count: number
	}>
	kv?: KVNamespace
	onUsageRollupsQuery?: (query: string) => void
}) {
	return {
		APP_DB: {
			prepare(query: string) {
				const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
				return {
					bind() {
						return this
					},
					async all<T>() {
						if (normalized.includes('from usage_rollups')) {
							// Require the JOIN predicate, not only SELECT personal_org_id AS org_id.
							const joinsOnPersonalOrg =
								/inner join users u on coalesce\(nullif\(trim\(u\.personal_org_id\), ''\), u\.stable_user_id\) = r\.user_id/.test(
									normalized,
								)
							if (
								!joinsOnPersonalOrg ||
								/inner join users u on u\.stable_user_id = r\.user_id/.test(
									normalized,
								)
							) {
								throw new Error(
									`Error-rate sweep must JOIN users on personalOrgIdSql = r.user_id: ${query}`,
								)
							}
							input.onUsageRollupsQuery?.(query)
							return {
								results: input.users.map((user) => ({
									...user,
									org_id: user.org_id ?? user.stable_user_id,
								})) as Array<T>,
							}
						}
						return { results: [] }
					},
				}
			},
		} as unknown as D1Database,
		APP_BASE_URL: 'https://kody.codes/',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		BUNDLE_ARTIFACTS_KV: input.kv,
	} as unknown as Env
}

test('error-rate emails skip below-threshold users and claim once per month', async () => {
	expect(shouldSendUserErrorRateEmail({ errorCount: 4, eventCount: 10 })).toBe(
		false,
	)
	expect(shouldSendUserErrorRateEmail({ errorCount: 5, eventCount: 30 })).toBe(
		false,
	)
	expect(shouldSendUserErrorRateEmail({ errorCount: 5, eventCount: 25 })).toBe(
		true,
	)
	expect(
		shouldSendUserErrorRateEmail({ errorCount: 10, eventCount: 200 }),
	).toBe(true)

	const { kv, store } = createKv()
	const now = new Date('2026-08-15T12:00:00.000Z')
	const env = createEnv({
		users: [
			{
				stable_user_id: 'user-low',
				email: 'low@example.com',
				event_count: 30,
				error_count: userErrorRateMinErrors,
			},
			{
				stable_user_id: 'user-hot',
				email: 'hot@example.com',
				event_count: 20,
				error_count: 10,
			},
		],
		kv,
	})

	const first = await sendUserErrorRateEmails({ env, now })
	expect(first).toEqual({ status: 'notified', emailedUsers: 1 })
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	const payload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		to: string
		html: string
		text: string
	}
	expect(payload.to).toBe('hot@example.com')
	expect(payload.html).toContain('https://kody.codes/account/activity')
	expect(payload.text).toContain('/support')
	expect(
		store.get(
			userErrorRateEmailKvKey({
				userId: ownerIdFromStored('user-hot'),
				month: '2026-08',
			}),
		),
	).toBeTruthy()

	sendCloudflareEmail.mockClear()
	const again = await sendUserErrorRateEmails({ env, now })
	expect(again).toEqual({ status: 'no_warnings' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
})

test('error-rate sweep joins usage rollups by personal org id when distinct from person id', async () => {
	sendCloudflareEmail.mockClear()
	listRunRecords.mockResolvedValueOnce({ runs: [], nextCursor: null })
	const personId = 'person-distinct'
	const orgId = 'org-distinct'
	expect(personId).not.toBe(orgId)
	const { kv, store } = createKv()
	const queries: Array<string> = []
	const result = await sendUserErrorRateEmails({
		env: createEnv({
			users: [
				{
					stable_user_id: personId,
					org_id: orgId,
					email: 'ada@example.com',
					event_count: 20,
					error_count: 10,
				},
			],
			kv,
			onUsageRollupsQuery(query) {
				queries.push(query)
			},
		}),
		now: new Date('2026-08-15T12:00:00.000Z'),
	})
	expect(result).toEqual({ status: 'notified', emailedUsers: 1 })
	expect(queries).toHaveLength(1)
	expect(queries[0]).toMatch(
		/INNER JOIN users u ON COALESCE\(NULLIF\(TRIM\(u\.personal_org_id\), ''\), u\.stable_user_id\) = r\.user_id/,
	)
	expect(queries[0]).not.toMatch(
		/INNER JOIN users u ON u\.stable_user_id = r\.user_id/,
	)
	expect(sendCloudflareEmail.mock.calls[0]?.[1]).toMatchObject({
		to: 'ada@example.com',
	})
	expect(listRunRecords).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerIdFromStored(orgId) }),
	)
	expect(
		store.get(
			userErrorRateEmailKvKey({
				userId: personId,
				month: '2026-08',
			}),
		),
	).toBeTruthy()
})

test('summarizeRunError keeps the first non-empty line and redacts Kody tokens', () => {
	expect(summarizeRunError({ errorMessage: '  first\nsecond' })).toBe('first')
	expect(summarizeRunError({ errorMessage: '\n  \nactual error\nmore' })).toBe(
		'actual error',
	)
	const token = `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`
	const redacted = summarizeRunError({
		errorMessage: `Unauthorized with ${token}`,
	})
	expect(redacted).toBe('Unauthorized with kody_at_[redacted]')
	expect(redacted).not.toContain('B'.repeat(43))
})
