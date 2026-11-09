import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const publishBuildState = defineStateMachine({
	name: 'publish_builds.status',
	description:
		'Builds upload, seal and commit or reject; a committed build may be finalized again or rejected by a later verification.',
	initial: 'uploading',
	transitions: {
		uploading: ['sealed'],
		sealed: ['committed', 'rejected'],
		committed: ['committed', 'rejected'],
		rejected: [],
	},
})

export type PublishBuildStatus = StateOf<typeof publishBuildState>
