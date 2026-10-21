import { expect, test } from 'vitest'
import {
	applyProbeResult,
	failureThreshold,
	initialComponentProbeState,
	recoveryThreshold,
	type ComponentProbeState,
} from './incidents.ts'

function run(
	state: ComponentProbeState,
	results: Array<boolean>,
): { state: ComponentProbeState; transitions: Array<string | null> } {
	const transitions: Array<string | null> = []
	let current = state
	for (const ok of results) {
		const applied = applyProbeResult(current, ok)
		current = applied.state
		transitions.push(applied.transition)
	}
	return { state: current, transitions }
}

test('probe hysteresis opens and resolves once at threshold and ignores flaps', () => {
	const flap = run(initialComponentProbeState, [
		false,
		true,
		false,
		true,
		false,
		true,
	])
	expect(flap.transitions.every((transition) => transition === null)).toBe(true)
	expect(flap.state.status).toBe('operational')

	const singleFailure = run(initialComponentProbeState, [false, true])
	expect(singleFailure.transitions).toEqual([null, null])
	expect(singleFailure.state.status).toBe('operational')

	const twoFailures = run(initialComponentProbeState, [false, false, true])
	expect(twoFailures.transitions).toEqual([null, null, null])
	expect(twoFailures.state.status).toBe('operational')

	expect(
		run(initialComponentProbeState, [false, false, false]).transitions,
	).toEqual([null, null, 'opened'])

	const failures = Array.from({ length: failureThreshold + 2 }, () => false)
	const opened = run(initialComponentProbeState, failures)
	expect(
		opened.transitions.filter((transition) => transition === 'opened'),
	).toHaveLength(1)
	expect(opened.transitions[failureThreshold - 1]).toBe('opened')
	expect(opened.state.status).toBe('down')

	const partialRecovery = run(opened.state, [true])
	if (recoveryThreshold > 1) {
		expect(partialRecovery.transitions).toEqual([null])
		expect(partialRecovery.state.status).toBe('down')
	}

	const successes = Array.from({ length: recoveryThreshold + 2 }, () => true)
	const resolved = run(opened.state, successes)
	expect(
		resolved.transitions.filter((transition) => transition === 'resolved'),
	).toHaveLength(1)
	expect(resolved.state.status).toBe('operational')
})
