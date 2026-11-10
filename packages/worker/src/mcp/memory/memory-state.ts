import { defineStatusEnum } from '@kody-internal/shared/state-machine.ts'

export const memoryState = defineStatusEnum({
	name: 'mcp_memories.status',
	description:
		'Memory insert and update APIs accept all status replacements, including archive, restore and deletion; soft deletion remains separate.',
	values: ['active', 'deleted', 'archived'],
})
export type MemoryStatus = (typeof memoryState.values)[number]
