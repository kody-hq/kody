import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	foldOnboardingFunnelRows,
	recordCheckoutFunnelEvent,
	recordMcpConnectFunnelEvent,
	recordOnboardingFunnelEvent,
} from './onboarding-funnel.ts'
import { stampFirstSearch } from './activation-stamps.ts'

const userId = ownerIdFromStored('a').repeat(64)

test('funnel points omit prompts, secrets, and non-stable ids', () => {
	const writeDataPoint = vi.fn()
	const env = {
		ONBOARDING_FUNNEL_EVENTS: { writeDataPoint },
	}
	recordOnboardingFunnelEvent(env, {
		stage: 'signup_completed',
		userId,
	})
	recordOnboardingFunnelEvent(env, {
		stage: 'signup_completed',
		userId: ownerIdFromStored('ada@example.com'),
	})
	recordMcpConnectFunnelEvent(env, {
		stage: 'mcp_connect_failed',
		userId,
		clientId: 'https://cursor.com/oauth?code=secret-value',
		clientName: 'Cursor',
		errorClass: 'please retry with password hunter2',
	})
	recordCheckoutFunnelEvent(env, {
		stage: 'checkout_started',
		userId,
		plan: 'pro',
	})
	recordCheckoutFunnelEvent(env, {
		stage: 'checkout_started',
		userId,
		plan: 'secret-plan',
	})
	expect(writeDataPoint).toHaveBeenCalledTimes(3)
	expect(writeDataPoint).toHaveBeenNthCalledWith(1, {
		indexes: [userId],
		blobs: ['signup_completed', '', '', ''],
		doubles: [1],
	})
	expect(writeDataPoint).toHaveBeenNthCalledWith(2, {
		indexes: [userId],
		blobs: ['mcp_connect_failed', 'cursor', 'other', 'cursor.com'],
		doubles: [1],
	})
	expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('hunter2')
	expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('secret')
	expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('ada@')
	consoleWarn.mockImplementation(() => {})
	writeDataPoint.mockImplementation(() => {
		throw new Error('analytics down')
	})
	expect(() =>
		recordOnboardingFunnelEvent(env, {
			stage: 'email_verified',
			userId,
		}),
	).not.toThrow()
	expect(consoleWarn).toHaveBeenCalledWith(
		'onboarding-funnel-event-failed',
		expect.any(Error),
	)
})

test('first search emits once even when the stamp is repeated', async () => {
	const writeDataPoint = vi.fn()
	const columns = new Map<string, string | null>()
	const db = {
		prepare(sql: string) {
			return {
				bind(...values: Array<unknown>) {
					return {
						async run() {
							if (sql.includes('SET first_search_at =')) {
								if (columns.get('first_search_at') == null) {
									columns.set('first_search_at', String(values[0]))
									return { meta: { changes: 1 } }
								}
								return { meta: { changes: 0 } }
							}
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database
	const env = { ONBOARDING_FUNNEL_EVENTS: { writeDataPoint } }
	expect(await stampFirstSearch(db, { stableUserId: userId }, env)).toBe(true)
	expect(await stampFirstSearch(db, { stableUserId: userId }, env)).toBe(false)
	expect(writeDataPoint).toHaveBeenCalledOnce()
	expect(writeDataPoint.mock.calls[0]?.[0]).toMatchObject({
		blobs: ['first_search', '', '', ''],
	})
})

test('funnel rows fold to known stages and missing stages stay zero', () => {
	const window = foldOnboardingFunnelRows(7, [
		{ stage: 'signup_completed', users: '4' },
		{ stage: 'not_a_stage', users: 9 },
		{ stage: 'first_search', users: 1 },
	])
	expect(
		window.steps.find((step) => step.stage === 'signup_completed'),
	).toEqual({ stage: 'signup_completed', users: 4 })
	expect(window.steps.find((step) => step.stage === 'first_job')).toEqual({
		stage: 'first_job',
		users: 0,
	})
})
