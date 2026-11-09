import { defineStateMachine } from '@kody-internal/shared/state-machine.ts'
export const avatarCropState = defineStateMachine({
	name: 'avatar.ui_crop',
	description:
		'Decoded previews exist only while editing or preparing; decode failures cannot be applied and preparation failures can be retried.',
	initial: 'decoding',
	transitions: {
		decoding: ['decoding', 'ready', 'decode_error'],
		ready: ['decoding', 'applying'],
		applying: ['decoding', 'prepare_error'],
		decode_error: ['decoding'],
		prepare_error: ['decoding', 'applying'],
	},
})
type Preview = {
	previewUrl: string
	imageSize: { width: number; height: number }
}
export type AvatarCropState =
	| { status: 'decoding' }
	| { status: 'decode_error'; error: string }
	| (Preview &
			(
				| { status: 'ready' | 'applying' }
				| { status: 'prepare_error'; error: string }
			))
