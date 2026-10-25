import { expect, test } from 'vitest'
import { preferLocalExecuteNudgeWarning } from '#universal/prefer-local-cli-execute.ts'
import {
	applyPreferLocalExecuteNudge,
	dailyFreshWorkersFromClaim,
	isKnownWebOnlyMcpClient,
	maxPreferLocalExecuteNudgeConversations,
	preferLocalExecuteFreshCodeThreshold,
	shouldTipPreferLocalExecuteNudge,
} from '#mcp/prefer-local-execute-nudge.ts'
import { userEntitlementApproachingThreshold } from '#worker/entitlements/user-entitlement-warning-emails.ts'

test('fresh-code threshold tips at N new workers today', () => {
	expect(
		shouldTipPreferLocalExecuteNudge({
			dailyFreshWorkers: preferLocalExecuteFreshCodeThreshold - 1,
			monthlyUniqueWorkerDays: null,
			monthlyInclude: null,
		}),
	).toBe(false)
	expect(
		shouldTipPreferLocalExecuteNudge({
			dailyFreshWorkers: preferLocalExecuteFreshCodeThreshold,
			monthlyUniqueWorkerDays: null,
			monthlyInclude: null,
		}),
	).toBe(true)
})

test('monthly include tips at the approaching threshold', () => {
	const include = 350
	const below = Math.floor(include * userEntitlementApproachingThreshold) - 1
	const atOrAbove = Math.ceil(include * userEntitlementApproachingThreshold)
	expect(
		shouldTipPreferLocalExecuteNudge({
			dailyFreshWorkers: 1,
			monthlyUniqueWorkerDays: below,
			monthlyInclude: include,
		}),
	).toBe(false)
	expect(
		shouldTipPreferLocalExecuteNudge({
			dailyFreshWorkers: 1,
			monthlyUniqueWorkerDays: atOrAbove,
			monthlyInclude: include,
		}),
	).toBe(true)
})

test('dailyFreshWorkersFromClaim requires a minted worker', () => {
	expect(dailyFreshWorkersFromClaim(null)).toBeNull()
	expect(dailyFreshWorkersFromClaim({ created: false, used: 12 })).toBeNull()
	expect(dailyFreshWorkersFromClaim({ created: true, used: 12 })).toBe(12)
})

test('known web-only OAuth clients are skipped', () => {
	expect(isKnownWebOnlyMcpClient('https://chatgpt.com/connector.json')).toBe(
		true,
	)
	expect(isKnownWebOnlyMcpClient('https://claude.ai/connector.json')).toBe(true)
	expect(isKnownWebOnlyMcpClient('https://grok.com/connector.json')).toBe(true)
	expect(isKnownWebOnlyMcpClient('https://cursor.com/mcp')).toBe(false)
	expect(isKnownWebOnlyMcpClient(null)).toBe(false)
	expect(isKnownWebOnlyMcpClient('unknown-client-id')).toBe(false)
})

test('prefer-local nudge fires once per conversation and evicts FIFO', () => {
	const first = applyPreferLocalExecuteNudge({
		state: null,
		conversationId: 'conv-a',
		shouldTip: true,
	})
	expect(first.nudges).toEqual([preferLocalExecuteNudgeWarning])
	expect(first.state.conversationIds).toEqual(['conv-a'])

	const repeat = applyPreferLocalExecuteNudge({
		state: first.state,
		conversationId: 'conv-a',
		shouldTip: true,
	})
	expect(repeat.nudges).toEqual([])

	const skipped = applyPreferLocalExecuteNudge({
		state: first.state,
		conversationId: 'conv-b',
		shouldTip: false,
	})
	expect(skipped.nudges).toEqual([])
	expect(skipped.state.conversationIds).toEqual(['conv-a'])

	let state = first.state
	for (let i = 0; i < maxPreferLocalExecuteNudgeConversations + 5; i++) {
		state = applyPreferLocalExecuteNudge({
			state,
			conversationId: `conv-${i}`,
			shouldTip: true,
		}).state
	}
	expect(state.conversationIds).toHaveLength(
		maxPreferLocalExecuteNudgeConversations,
	)
	expect(state.conversationIds[0]).toBe('conv-5')
})
