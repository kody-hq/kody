import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { getEntitySourceByEntity } from '#worker/repo/entity-sources.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'
import {
	getUserRepoById,
	getUserRepoByName,
	type UserRepoRecord,
} from '#worker/repo/user-repos.ts'

export type UserRepoIdentity = {
	repo_id?: string
	name?: string
}

function requireExactlyOneUserRepoIdentity(input: UserRepoIdentity) {
	const count =
		(input.repo_id !== undefined ? 1 : 0) + (input.name !== undefined ? 1 : 0)
	if (count !== 1) {
		throw new McpCallerError('Provide exactly one of `repo_id` or `name`.')
	}
}

/**
 * Resolve a plain repo the caller owns.
 *
 * - `name` looks up by normalized repo name.
 * - `repo_id` tries UUID id first, then falls back to name. OpenAPI path
 *   `/v1/repos/{repo_id}/…` therefore accepts a UUID or a repo name (same
 *   pattern as MCP server `{server}` id-or-name). Prefer the body-only
 *   `/v1/repos/git-remote` alias when calling with `name` from OpenAPI/CLI.
 */
export async function resolveOwnedUserRepo(input: {
	db: D1Database
	userId: OwnerId
	args: UserRepoIdentity
}): Promise<{ userRepo: UserRepoRecord; source: EntitySourceRow }> {
	requireExactlyOneUserRepoIdentity(input.args)
	const userRepo =
		input.args.repo_id !== undefined
			? await resolveUserRepoByIdOrName({
					db: input.db,
					userId: input.userId,
					repoIdOrName: input.args.repo_id,
				})
			: await getUserRepoByName(input.db, {
					userId: input.userId,
					name: input.args.name ?? '',
				})
	if (!userRepo) {
		const missingId = input.args.repo_id ?? input.args.name
		throw new McpCallerError(`Plain repo "${missingId}" was not found.`)
	}
	const source = await getEntitySourceByEntity(input.db, {
		userId: input.userId,
		entityKind: 'repo',
		entityId: userRepo.id,
	})
	if (!source) {
		throw new McpCallerError('Repo source was not found for this user.')
	}
	return { userRepo, source }
}

async function resolveUserRepoByIdOrName(input: {
	db: D1Database
	userId: OwnerId
	repoIdOrName: string
}): Promise<UserRepoRecord | null> {
	const byId = await getUserRepoById(input.db, {
		userId: input.userId,
		repoId: input.repoIdOrName,
	})
	if (byId) return byId
	return await getUserRepoByName(input.db, {
		userId: input.userId,
		name: input.repoIdOrName,
	})
}
