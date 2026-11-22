import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const publishBuildState = setup({
	schemas: {
		events: { SEAL: types<{}>(), COMMIT: types<{}>(), REJECT: types<{}>() },
	},
}).createMachine({
	id: 'publish_builds.status',
	description:
		'Builds upload, seal and commit or reject; an uploading build is rejected when a chunk scan blocks a chunk, and a committed build may be finalized again or rejected by a later verification.',
	initial: 'uploading',
	states: {
		uploading: {
			on: { SEAL: { target: 'sealed' }, REJECT: { target: 'rejected' } },
		},
		sealed: {
			on: { COMMIT: { target: 'committed' }, REJECT: { target: 'rejected' } },
		},
		committed: {
			on: { COMMIT: { target: 'committed' }, REJECT: { target: 'rejected' } },
		},
		rejected: { type: 'final' },
	},
})

export type PublishBuildStatus = LifecycleStateOf<typeof publishBuildState>
