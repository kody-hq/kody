import { expect, test } from 'vitest'
import { createStateMachineStore } from '#client/state-machine-store.ts'
import {
	connectOauthStepState,
	connectOauthOperationState,
	type ConnectOauthStep,
} from './connect-oauth-state.ts'

test('OAuth setup cannot skip to a receipt, and one request fences submission', () => {
	expect(connectOauthStepState.can('setup', 'success')).toBe(false)
	expect(connectOauthStepState.can('device', 'callback')).toBe(false)
	expect(connectOauthStepState.can('success', 'connect')).toBe(false)
	expect(connectOauthStepState.can('success', 'setup')).toBe(true)
	expect(connectOauthOperationState.can('submitting', 'submitting')).toBe(false)

	const operation = createStateMachineStore(connectOauthOperationState, {
		status: 'idle',
	})
	expect(operation.transition({ status: 'submitting' })).toBe(true)
	expect(operation.transition({ status: 'submitting' })).toBe(false)
	expect(operation.transition({ status: 'idle' })).toBe(true)

	const step = createStateMachineStore<{ status: ConnectOauthStep }>(
		connectOauthStepState,
		{ status: 'setup' },
	)
	expect(step.transition({ status: 'success' })).toBe(false)
	expect(step.transition({ status: 'connect' })).toBe(true)
	expect(step.transition({ status: 'device' })).toBe(true)
	expect(step.transition({ status: 'success' })).toBe(true)
	expect(step.transition({ status: 'callback' })).toBe(false)
})
