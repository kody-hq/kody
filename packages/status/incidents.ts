/**
 * Per-component incident state machine. Consecutive-failure thresholds keep a
 * single flaky probe from opening an incident, and consecutive-success
 * thresholds keep a single lucky probe from resolving one.
 */

import {
	componentIncidentState,
	type ComponentIncidentStatus,
} from './incident-state.ts'

export const failureThreshold = 3
export const recoveryThreshold = 2

export type ComponentProbeState = {
	status: ComponentIncidentStatus
	consecutiveFailures: number
	consecutiveSuccesses: number
}

export const initialComponentProbeState: ComponentProbeState = {
	status: 'operational',
	consecutiveFailures: 0,
	consecutiveSuccesses: 0,
}

export type ComponentTransition = 'opened' | 'resolved' | null

export function applyProbeResult(
	state: ComponentProbeState,
	ok: boolean,
): { state: ComponentProbeState; transition: ComponentTransition } {
	if (ok) {
		const consecutiveSuccesses = state.consecutiveSuccesses + 1
		if (state.status === 'down' && consecutiveSuccesses >= recoveryThreshold) {
			componentIncidentState.assert(state.status, 'operational')
			return {
				state: {
					status: 'operational',
					consecutiveFailures: 0,
					consecutiveSuccesses,
				},
				transition: 'resolved',
			}
		}
		return {
			state: {
				status: state.status,
				consecutiveFailures: 0,
				consecutiveSuccesses,
			},
			transition: null,
		}
	}
	const consecutiveFailures = state.consecutiveFailures + 1
	if (
		state.status === 'operational' &&
		consecutiveFailures >= failureThreshold
	) {
		componentIncidentState.assert(state.status, 'down')
		return {
			state: {
				status: 'down',
				consecutiveFailures,
				consecutiveSuccesses: 0,
			},
			transition: 'opened',
		}
	}
	return {
		state: {
			status: state.status,
			consecutiveFailures,
			consecutiveSuccesses: 0,
		},
		transition: null,
	}
}
