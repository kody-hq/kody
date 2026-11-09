import { stateMachines as cliStateMachines } from '../packages/cli/src/state-machines.ts'
import { stateMachines as backupStateMachines } from '../packages/backup-control-plane/state-machines.ts'
import { stateMachines as workerStateMachines } from '../packages/worker/src/state-machines.ts'
import { stateMachines as statusStateMachines } from '../packages/status/state-machines.ts'

export const stateMachines = [
	...workerStateMachines,
	...statusStateMachines,
	...cliStateMachines,
	...backupStateMachines,
] as const
