import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const publishBuildState = setup({
	schemas: {
		events: {
			SEAL: types<{}>(),
			ABANDON: types<{}>(),
			COMMIT: types<{}>(),
			REJECT: types<{}>(),
		},
	},
}).createMachine({
	id: 'publish_builds.status',
	description:
		'Builds upload, then seal and commit or reject, or the builder abandons the upload; a committed build may be finalized again or rejected by a later verification.',
	initial: 'uploading',
	states: {
		uploading: {
			on: { SEAL: { target: 'sealed' }, ABANDON: { target: 'abandoned' } },
		},
		sealed: {
			on: { COMMIT: { target: 'committed' }, REJECT: { target: 'rejected' } },
		},
		committed: {
			on: { COMMIT: { target: 'committed' }, REJECT: { target: 'rejected' } },
		},
		rejected: { type: 'final' },
		abandoned: { type: 'final' },
	},
})

export type PublishBuildStatus = LifecycleStateOf<typeof publishBuildState>
