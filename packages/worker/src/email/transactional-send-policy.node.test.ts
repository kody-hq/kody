import { expect, test, vi } from 'vitest'
import {
	categoryForTransactionalEmailKind,
	gateTransactionalSend,
} from './transactional-send-policy.ts'

test('classifies essential vs holdable transactional kinds', () => {
	expect(categoryForTransactionalEmailKind('email_verification')).toBe(
		'essential',
	)
	expect(categoryForTransactionalEmailKind('password_reset')).toBe('essential')
	expect(categoryForTransactionalEmailKind('billing_success')).toBe('essential')
	expect(categoryForTransactionalEmailKind('connect_agent')).toBe('holdable')
	expect(categoryForTransactionalEmailKind('advocate_referral')).toBe(
		'holdable',
	)
	expect(categoryForTransactionalEmailKind('entitlement_warning')).toBe(
		'holdable',
	)
	expect(categoryForTransactionalEmailKind('mystery_campaign')).toBe('holdable')
})

test('gate holds holdable mail for active rejecting providers', async () => {
	const now = new Date('2026-10-17T12:00:00.000Z')
	const rejecting = new Map([['messagingengine.com', now.toISOString()]])
	const mxCache = new Map([
		[
			'coderunr.net',
			{
				provider_keys_json: JSON.stringify(['messagingengine.com']),
				mx_hosts_json: JSON.stringify(['in1-smtp.messagingengine.com']),
				expires_at: '2026-10-18T12:00:00.000Z',
			},
		],
	])
	const db = {
		prepare(sql: string) {
			const bound = (...binds: Array<unknown>) => ({
				async first<T>() {
					if (sql.includes('FROM email_recipient_cooldowns')) {
						return null
					}
					if (sql.includes('FROM email_mx_lookup_cache')) {
						return (mxCache.get(String(binds[0])) as T | undefined) ?? null
					}
					if (
						sql.includes('FROM email_rejecting_providers') &&
						sql.includes('provider_key = ?')
					) {
						const key = String(binds[0])
						const at = rejecting.get(key)
						if (!at) return null
						return { last_rejection_at: at } as T
					}
					return null
				},
				async all<T>() {
					if (sql.includes('FROM email_rejecting_providers')) {
						const results = [...rejecting.entries()].map(
							([provider_key, last_rejection_at]) => ({
								provider_key,
								last_rejection_at,
								rejection_count: 1,
								last_recipient_domain: null,
								seeded: 0,
							}),
						)
						return { results: results as Array<T> }
					}
					return { results: [] as Array<T> }
				},
				async run() {
					return { meta: { changes: 0 } }
				},
			})
			return {
				bind: bound,
				...bound(),
			}
		},
	} as unknown as D1Database

	const held = await gateTransactionalSend({
		db,
		recipient: 'accounts+kody@coderunr.net',
		category: 'holdable',
		now,
	})
	expect(held).toMatchObject({
		allowed: false,
		code: 'provider_hold',
		providerKey: 'messagingengine.com',
	})

	const essential = await gateTransactionalSend({
		db,
		recipient: 'accounts+kody@coderunr.net',
		category: 'essential',
		now,
	})
	expect(essential).toEqual({ allowed: true })
})

test('password reset kinds stop on a hard bounce and do not read the verification cap', async () => {
	const queries: Array<string> = []
	const db = {
		prepare(sql: string) {
			queries.push(sql)
			return {
				bind() {
					return {
						async first() {
							if (sql.includes('email_verification_hard_bounces')) {
								return { recipient: 'ada@example.com', status: 'bounced' }
							}
							return null
						},
						async run() {
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	const reset = await gateTransactionalSend({
		db,
		recipient: 'ada@example.com',
		category: 'essential',
		kind: 'password_reset',
	})
	expect(reset).toMatchObject({
		allowed: false,
		code: 'recipient_hard_bounce',
	})
	const confirmed = await gateTransactionalSend({
		db,
		recipient: 'ada@example.com',
		category: 'essential',
		kind: 'password_reset_confirmed',
	})
	expect(confirmed).toMatchObject({
		allowed: false,
		code: 'recipient_hard_bounce',
	})
	const verification = await gateTransactionalSend({
		db,
		recipient: 'ada@example.com',
		category: 'essential',
		kind: 'email_verification',
	})
	expect(verification).toEqual({ allowed: true })
	expect(queries.join('\n')).not.toMatch(/_rate_limits|verify-email:recipient/)
})

test('password reset hard-bounce lookup fails open when the table is missing', async () => {
	const db = {
		prepare() {
			return {
				bind() {
					return {
						async first() {
							throw new Error('no such table: email_verification_hard_bounces')
						},
					}
				},
			}
		},
	} as unknown as D1Database
	expect(
		await gateTransactionalSend({
			db,
			recipient: 'ada@example.com',
			category: 'essential',
			kind: 'password_reset',
		}),
	).toEqual({ allowed: true })
})

test('gate fails open when policy tables are missing', async () => {
	const db = {
		prepare() {
			return {
				bind() {
					return {
						async first() {
							throw new Error('no such table: email_recipient_cooldowns')
						},
					}
				},
			}
		},
	} as unknown as D1Database
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	expect(
		await gateTransactionalSend({
			db,
			recipient: 'ada@example.com',
			category: 'holdable',
		}),
	).toEqual({ allowed: true })
	warn.mockRestore()
})
