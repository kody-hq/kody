import { stateMachines as workerStateMachines } from '../packages/worker/src/state-machines.ts'
import { stateMachines as statusStateMachines } from '../packages/status/state-machines.ts'

export const stateMachines = [
	...workerStateMachines,
	...statusStateMachines,
] as const
