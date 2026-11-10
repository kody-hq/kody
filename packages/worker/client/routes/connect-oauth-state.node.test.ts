import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import {
	connectOauthStepState,
	connectOauthOperationState,
} from './connect-oauth-state.ts'
test('OAuth setup cannot skip to a receipt, and one request fences submission', () => {
	expect(canHandle(connectOauthStepState, 'setup', 'CREDENTIALS_SAVED')).toBe(
		false,
	)
	expect(canHandle(connectOauthStepState, 'device', 'CALLBACK')).toBe(false)
	expect(canHandle(connectOauthStepState, 'success', 'CONNECT')).toBe(false)
	expect(canHandle(connectOauthStepState, 'success', 'SETUP')).toBe(true)
	expect(canHandle(connectOauthOperationState, 'submitting', 'SUBMIT')).toBe(
		false,
	)

	const operation = createActor(connectOauthOperationState, {
		snapshot: (() => {
			const initialView = {
				status: 'idle',
			}
			return connectOauthOperationState.resolveState({
				value: initialView.status,
				context: uiContext(initialView),
			})
		})(),
	}).start()
	expect(
		sendUiEvent(operation, {
			type: 'SUBMIT',
			data: uiContext({ status: 'submitting' }).data,
		} as Parameters<typeof operation.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(operation, {
			type: 'SUBMIT',
			data: uiContext({ status: 'submitting' }).data,
		} as Parameters<typeof operation.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(operation, {
			type: 'SETTLED',
			data: uiContext({ status: 'idle' }).data,
		} as Parameters<typeof operation.send>[0]),
	).toBe(true)

	const step = createActor(connectOauthStepState).start()
	expect(
		sendUiEvent(step, {
			type: 'CREDENTIALS_SAVED',
			data: uiContext({ status: 'success' }).data,
		} as Parameters<typeof step.send>[0]),
	).toBe(false)
	expect(
		sendUiEvent(step, {
			type: 'CONNECT',
			data: uiContext({ status: 'connect' }).data,
		} as Parameters<typeof step.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(step, {
			type: 'DEVICE',
			data: uiContext({ status: 'device' }).data,
		} as Parameters<typeof step.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(step, {
			type: 'CREDENTIALS_SAVED',
			data: uiContext({ status: 'success' }).data,
		} as Parameters<typeof step.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(step, {
			type: 'CALLBACK',
			data: uiContext({ status: 'callback' }).data,
		} as Parameters<typeof step.send>[0]),
	).toBe(false)
})
