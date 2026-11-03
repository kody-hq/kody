import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { repoSessionIndexDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import type { RepoSessionIndexRpc } from './repo-session-index-do.ts'

export type RepoSessionIndexEnv = {
	REPO_SESSION_INDEX?: DurableObjectNamespace
	APP_DB: D1Database
}

export function repoSessionIndexNamespace(
	env: RepoSessionIndexEnv,
): DurableObjectNamespace | null {
	return env.REPO_SESSION_INDEX ?? null
}

/** Typed per-user RepoSessionIndex RPC stub; throws when the binding is missing. */
export function repoSessionIndexRpc(input: {
	env: RepoSessionIndexEnv
	userId: OwnerId
}): RepoSessionIndexRpc {
	const namespace = repoSessionIndexNamespace(input.env)
	if (!namespace) {
		throw new Error(
			'REPO_SESSION_INDEX Durable Object binding is not configured.',
		)
	}
	return namespace.get(
		namespace.idFromName(repoSessionIndexDurableObjectName(input.userId)),
	) as unknown as RepoSessionIndexRpc
}

export type { RepoSessionIndexRpc }
