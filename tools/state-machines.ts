import { stateMachines as cliStateMachines } from '../packages/cli/src/state-machines.ts'
import { stateMachines as backupStateMachines } from '../packages/backup-control-plane/state-machines.ts'
import { stateMachines as workerStateMachines } from '../packages/worker/src/state-machines.ts'
import { stateMachines as statusStateMachines } from '../packages/status/state-machines.ts'

import { stateMachines as uiStateMachines } from '../packages/worker/client/state-machines.ts'

import { stateMachines as desktopStateMachines } from '../packages/desktop/state-machines.mts'

export const stateMachines = [
	...workerStateMachines,
	...statusStateMachines,
	...cliStateMachines,
	...backupStateMachines,
	...uiStateMachines,
	...desktopStateMachines,
] as const
