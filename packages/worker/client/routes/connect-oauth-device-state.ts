import { defineStateMachine } from '@kody-internal/shared/state-machine.ts'
export const connectOauthDeviceState = defineStateMachine({
	name: 'connect_oauth.device_poll',
	description:
		'A device session polls with transient retries until provider completion or expiry; an already committed late approval remains authoritative after the local deadline.',
	initial: 'idle',
	transitions: {
		idle: ['idle', 'starting'],
		starting: ['polling', 'error', 'idle'],
		polling: ['polling', 'error', 'success', 'idle'],
		error: ['idle', 'success'],
		success: ['idle'],
	},
})
export type DeviceDisplay = {
	userCode: string
	verificationUri: string
	verificationUriComplete: string | null
	expiresIn: number
}
export type DeviceSession = DeviceDisplay & {
	sessionId: string
	interval: number
}
export type ConnectOauthDeviceState =
	| { status: 'idle' | 'starting' }
	| { status: 'polling'; session: DeviceSession }
	| { status: 'error'; message: string; view: DeviceDisplay | null }
	| { status: 'success'; view: DeviceDisplay }
