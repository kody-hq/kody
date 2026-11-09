import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const emailProcessingState = defineStateMachine({
	name: 'email_messages.processing_status',
	description:
		'Email metadata inserts and timestamp-fenced partial updates accept all processing statuses; normal outbound sends move stored to sent or failed.',
	initial: ['stored', 'sent', 'failed'],
	transitions: {
		stored: ['stored', 'sent', 'failed'],
		sent: ['stored', 'sent', 'failed'],
		failed: ['stored', 'sent', 'failed'],
	},
})
export type EmailProcessingStatus = StateOf<typeof emailProcessingState>
