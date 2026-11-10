import { defineStatusEnum } from '@kody-internal/shared/state-machine.ts'

export const repoSessionState = defineStatusEnum({
	name: 'repo_sessions.status',
	description:
		'Repo session storage accepts all status replacements; normal sessions publish or discard, including repeated finalization.',
	values: ['active', 'published', 'discarded'],
})
export type RepoSessionStatus = (typeof repoSessionState.values)[number]
