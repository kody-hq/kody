import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const repoSessionState = defineStateMachine({
	name: 'repo_sessions.status',
	description:
		'Repo session storage accepts all status replacements; normal sessions publish or discard, including repeated finalization.',
	initial: ['active', 'published', 'discarded'],
	transitions: {
		active: ['active', 'published', 'discarded'],
		published: ['active', 'published', 'discarded'],
		discarded: ['active', 'published', 'discarded'],
	},
})
export type RepoSessionStatus = StateOf<typeof repoSessionState>
