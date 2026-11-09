import { expect, test } from 'vitest'
import {
	connectOauthStepState,
	connectOauthOperationState,
} from './connect-oauth-state.ts'
test('OAuth setup and request graphs', () => {
	expect(connectOauthStepState.transitions).toEqual({
		setup: ['setup', 'connect', 'callback'],
		connect: ['connect', 'setup', 'device', 'callback'],
		device: ['device', 'connect', 'success'],
		callback: ['callback', 'setup', 'connect', 'success'],
		success: ['success', 'setup'],
	})
	expect(connectOauthOperationState.transitions).toEqual({
		idle: ['submitting'],
		submitting: ['idle'],
	})
})
