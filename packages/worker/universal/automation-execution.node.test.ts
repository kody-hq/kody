import { expect, test } from 'vitest'
import {
	automationExecutionFormFrom,
	automationExecutionFromForm,
	describeAutomationExecution,
	emptyAutomationExecutionForm,
} from './automation-execution.ts'

test('cloud form with no requirements clears the setting', () => {
	expect(automationExecutionFromForm(emptyAutomationExecutionForm())).toBe(null)
})

test('context form round-trips with fallback and queue', () => {
	const value = {
		context: 'studio-mac',
		fallback: 'chain' as const,
		requires: ['fs' as const],
		whenOffline: 'queue' as const,
		queueMinutes: 90,
	}
	expect(
		automationExecutionFromForm(automationExecutionFormFrom(value)),
	).toEqual(value)
})

test('chain form keeps order, caps at three contexts, and puts cloud last', () => {
	const form = {
		...emptyAutomationExecutionForm(),
		mode: 'chain' as const,
		chain: ['a', 'b', 'c', 'd'],
		cloudLast: true,
		whenOffline: 'queue' as const,
		queueMinutes: 99_999,
	}
	expect(automationExecutionFromForm(form)).toEqual({
		chain: ['a', 'b', 'c', 'cloud'],
		whenOffline: 'queue',
		queueMinutes: 1440,
	})
	expect(automationExecutionFormFrom({ chain: ['a', 'cloud'] })).toMatchObject({
		mode: 'chain',
		chain: ['a'],
		cloudLast: true,
	})
})

test('describes settings in plain words', () => {
	expect(describeAutomationExecution(null)).toBe('Kody cloud')
	expect(
		describeAutomationExecution({ context: 'id-1' }, () => 'Studio Mac'),
	).toBe('Studio Mac only · fails when offline')
	expect(
		describeAutomationExecution({
			chain: ['a', 'cloud'],
			requires: ['lan'],
			whenOffline: 'queue',
		}),
	).toBe('a → Kody cloud · needs lan · queues up to 60 min when offline')
})
