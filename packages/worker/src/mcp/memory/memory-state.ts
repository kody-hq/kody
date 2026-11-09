import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const memoryState = defineStateMachine({
	name: 'mcp_memories.status',
	description:
		'Memory insert and update APIs accept all status replacements, including archive, restore and deletion; soft deletion remains separate.',
	initial: ['active', 'deleted', 'archived'],
	transitions: {
		active: ['active', 'deleted', 'archived'],
		deleted: ['active', 'deleted', 'archived'],
		archived: ['active', 'deleted', 'archived'],
	},
})
export type MemoryStatus = StateOf<typeof memoryState>
