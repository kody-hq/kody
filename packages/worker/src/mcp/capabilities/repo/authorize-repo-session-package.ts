import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	authorize,
	authorizePackageWrite,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { getEntitySourceByIdForUser } from '#worker/repo/entity-sources.ts'
import { getRepoSessionById } from '#worker/repo/repo-sessions.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'

type RepoSessionAuthorizationInput = {
	env: Env
	request: RequestContext | null
	/** The org that owns the session: the org the connection is bound to. */
	userId: OwnerId
	sessionId: string
}

async function loadRepoSessionSource(
	input: RepoSessionAuthorizationInput & { allowMissingSession?: boolean },
): Promise<EntitySourceRow | null> {
	const session = await getRepoSessionById(input.env, {
		userId: input.userId,
		sessionId: input.sessionId,
	})
	if (!session) {
		if (input.allowMissingSession) return null
		throw new McpCallerError('Repo session was not found.')
	}
	const source = await getEntitySourceByIdForUser(input.env.APP_DB, {
		id: session.source_id,
		userId: input.userId,
	})
	if (!source) {
		throw new McpCallerError('Repo source was not found for this user.')
	}
	return source
}

/**
 * package:write on the package behind a repo session. Plain repos and jobs
 * are not packages, so a profile does not narrow them.
 */
export async function authorizeRepoSessionPackageWrite(
	input: RepoSessionAuthorizationInput & {
		/**
		 * `repoDiscardSession` is idempotent. A missing catalog row is a
		 * successful no-op (`deleted: false`), so the write check only runs
		 * when the session still exists.
		 */
		allowMissingSession?: boolean
	},
): Promise<void> {
	const source = await loadRepoSessionSource(input)
	if (source?.entity_kind !== 'package') return
	await authorizePackageWrite(
		{ env: input.env, request: input.request },
		{ id: source.entity_id, userId: source.user_id },
	)
}

/**
 * package:read on the package behind a repo session. Sessions belong to the
 * org, so a member reads one only when they may read its package.
 */
export async function authorizeRepoSessionPackageRead(
	input: RepoSessionAuthorizationInput,
): Promise<EntitySourceRow | null> {
	const source = await loadRepoSessionSource(input)
	if (source?.entity_kind !== 'package') return null
	await authorize(
		{ env: input.env, request: input.request },
		'package:read',
		packageResource({ id: source.entity_id, userId: source.user_id }),
	)
	return source
}
