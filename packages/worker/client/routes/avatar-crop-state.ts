import { setup, types } from 'xstate'
import type { UiContext, UiData, UiPayload } from '#client/ui-actor.ts'
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

export const avatarCropState = setup({
	schemas: {
		context: types<UiContext<AvatarCropState>>(),
		events: {
			DECODE: types<{
				data: UiPayload<AvatarCropState, 'decoding'>
				requestId?: unknown
			}>(),
			DECODE_OK: types<{
				data: UiPayload<AvatarCropState, 'ready'>
				requestId?: unknown
			}>(),
			DECODE_ERROR: types<{
				data: UiPayload<AvatarCropState, 'decode_error'>
				requestId?: unknown
			}>(),
			APPLY: types<{
				data: UiPayload<AvatarCropState, 'applying'>
				requestId?: unknown
			}>(),
			PREPARE_ERROR: types<{
				data: UiPayload<AvatarCropState, 'prepare_error'>
				requestId?: unknown
			}>(),
		},
	},
}).createMachine({
	id: 'avatar.ui_crop',
	description:
		'Decoded previews exist only while editing or preparing; decode failures cannot be applied and preparation failures can be retried.',
	initial: 'decoding',
	context: { data: {} as UiData<AvatarCropState>, requestId: undefined },
	states: {
		decoding: {
			on: {
				DECODE: {
					target: 'decoding',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				DECODE_OK: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<AvatarCropState>
						event: { type: 'DECODE_OK' } & {
							data: UiPayload<AvatarCropState, 'ready'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'ready', context: { data: event.data } }
					},
				},
				DECODE_ERROR: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<AvatarCropState>
						event: { type: 'DECODE_ERROR' } & {
							data: UiPayload<AvatarCropState, 'decode_error'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'decode_error', context: { data: event.data } }
					},
				},
			},
		},
		ready: {
			on: {
				DECODE: {
					target: 'decoding',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				APPLY: {
					target: 'applying',
					context: ({ event }) => ({ data: event.data }),
				},
			},
		},
		applying: {
			on: {
				DECODE: {
					target: 'decoding',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				PREPARE_ERROR: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<AvatarCropState>
						event: { type: 'PREPARE_ERROR' } & {
							data: UiPayload<AvatarCropState, 'prepare_error'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'prepare_error', context: { data: event.data } }
					},
				},
			},
		},
		decode_error: {
			on: {
				DECODE: {
					target: 'decoding',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
		prepare_error: {
			on: {
				DECODE: {
					target: 'decoding',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				APPLY: {
					target: 'applying',
					context: ({ event }) => ({ data: event.data }),
				},
			},
		},
	},
})
