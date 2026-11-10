import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const publishBuildState = setup({
	types: {
		events: {} as { type: 'SEAL' } | { type: 'COMMIT' } | { type: 'REJECT' },
	},
}).createMachine({
	id: 'publish_builds.status',
	description:
		'Builds upload, seal and commit or reject; a committed build may be finalized again or rejected by a later verification.',
	initial: 'uploading',
	states: {
		uploading: { on: { SEAL: 'sealed' } },
		sealed: { on: { COMMIT: 'committed', REJECT: 'rejected' } },
		committed: { on: { COMMIT: 'committed', REJECT: 'rejected' } },
		rejected: { type: 'final' },
	},
})

export type PublishBuildStatus = LifecycleStateOf<typeof publishBuildState>
