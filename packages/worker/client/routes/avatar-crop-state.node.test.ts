import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
import { expect, test } from 'vitest'
import { avatarCropState, type AvatarCropState } from './avatar-crop-state.ts'
test('avatar-crop pins legal UI transitions', () => {
	expect([...avatarCropState.events].sort()).toEqual([
		'APPLY',
		'DECODE',
		'DECODE_ERROR',
		'DECODE_OK',
		'PREPARE_ERROR',
	])
})

test('preparation errors can retry without stale error payloads', () => {
	const store = createActor(avatarCropState, {
		snapshot: (() => {
			const initialView = {
				status: 'decoding',
			}
			return avatarCropState.resolveState({
				value: initialView.status,
				context: uiContext(initialView),
			})
		})(),
	}).start()
	const preview = {
		previewUrl: 'blob:preview',
		imageSize: { width: 500, height: 500 },
	}
	sendUiEvent(store, {
		type: 'DECODE_OK',
		data: uiContext({ status: 'ready', ...preview }).data,
	} as Parameters<typeof store.send>[0])
	expect(
		sendUiEvent(store, {
			type: 'APPLY',
			data: uiContext({ status: 'applying', ...preview }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(true)
	expect(
		sendUiEvent(store, {
			type: 'APPLY',
			data: uiContext({ status: 'applying', ...preview }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
	sendUiEvent(store, {
		type: 'PREPARE_ERROR',
		data: uiContext({ status: 'prepare_error', ...preview, error: 'Failed' })
			.data,
	} as Parameters<typeof store.send>[0])
	sendUiEvent(store, {
		type: 'APPLY',
		data: uiContext({ status: 'applying', ...preview }).data,
	} as Parameters<typeof store.send>[0])
	expect(uiState<AvatarCropState>(store.getSnapshot())).not.toHaveProperty(
		'error',
	)
	sendUiEvent(store, {
		type: 'DECODE',
		data: uiContext({ status: 'decoding' }).data,
	} as Parameters<typeof store.send>[0])
	sendUiEvent(store, {
		type: 'DECODE_ERROR',
		data: uiContext({ status: 'decode_error', error: 'Invalid image' }).data,
	} as Parameters<typeof store.send>[0])
	expect(
		sendUiEvent(store, {
			type: 'APPLY',
			data: uiContext({ status: 'applying', ...preview }).data,
		} as Parameters<typeof store.send>[0]),
	).toBe(false)
})
