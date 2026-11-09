import { expect, test } from 'vitest'
import { createStateMachineStore } from '../state-machine-store.ts'
import { avatarCropState, type AvatarCropState } from './avatar-crop-state.ts'
test('avatar-crop pins legal UI transitions', () => {
	expect(avatarCropState.transitions).toEqual({
		decoding: ['decoding', 'ready', 'decode_error'],
		ready: ['decoding', 'applying'],
		applying: ['decoding', 'prepare_error'],
		decode_error: ['decoding'],
		prepare_error: ['decoding', 'applying'],
	})
})

test('preparation errors can retry without stale error payloads', () => {
	const store = createStateMachineStore<AvatarCropState>(avatarCropState, {
		status: 'decoding',
	})
	const preview = {
		previewUrl: 'blob:preview',
		imageSize: { width: 500, height: 500 },
	}
	store.transition({ status: 'ready', ...preview })
	expect(store.transition({ status: 'applying', ...preview })).toBe(true)
	expect(store.transition({ status: 'applying', ...preview })).toBe(false)
	store.transition({ status: 'prepare_error', ...preview, error: 'Failed' })
	store.transition({ status: 'applying', ...preview })
	expect(store.getSnapshot()).not.toHaveProperty('error')
	store.transition({ status: 'decoding' })
	store.transition({ status: 'decode_error', error: 'Invalid image' })
	expect(store.transition({ status: 'applying', ...preview })).toBe(false)
})
