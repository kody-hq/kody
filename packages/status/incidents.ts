import { nextState } from '@kody-internal/shared/state-machine.ts'
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
			nextState(componentIncidentState, state.status, {
				type: 'RESOLVE_INCIDENT',
			})
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
		nextState(componentIncidentState, state.status, { type: 'OPEN_INCIDENT' })
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
