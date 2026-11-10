import { defineStatusEnum } from '@kody-internal/shared/state-machine.ts'

export const emailProcessingState = defineStatusEnum({
	name: 'email_messages.processing_status',
	description:
		'Email metadata inserts and timestamp-fenced partial updates accept all processing statuses; normal outbound sends move stored to sent or failed.',
	values: ['stored', 'sent', 'failed'],
})
export type EmailProcessingStatus = (typeof emailProcessingState.values)[number]
