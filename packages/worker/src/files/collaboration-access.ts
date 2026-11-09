import {
	fileCollaborationEnabled,
	fileEffectivePermissions,
} from './feature.ts'
import { fileTreePermission, loadFileAncestors } from './tree-access.ts'
import { fileStoreRpc } from './client.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { loadLiveOrgBindingForOrg } from '#worker/orgs/repo.ts'
import {
	type CollaborationAccess,
	type CollaborationActor,
} from '#universal/file-collaboration.ts'

/** Room callers supply server-derived contexts. Never accept one from client JSON. */
export async function fileCollaborationAccess(
	env: Env,
	request: RequestContext,
	fileId: string,
): Promise<{
	request: RequestContext
	access: CollaborationAccess
	actor: CollaborationActor
}> {
	if (!request.actor) throw new Error('Sign in to open this file.')
	const binding = await loadLiveOrgBindingForOrg(
		env.APP_DB,
		request.actor.userId,
		request.org.id,
	)
	if (!binding) throw new Error('File access was revoked.')
	const fresh = {
		...request,
		membership: binding.role ? { role: binding.role } : null,
	}
	const effective = await fileEffectivePermissions(env, fresh)
	const store = fileStoreRpc(env, request.org.id)
	const files = await loadFileAncestors(
		(id) => store.metadata(request.org.id, id),
		fileId,
	)
	const holds = (
		permission:
			| 'file:read'
			| 'file:write'
			| 'file:comment'
			| 'file:manage_access',
	) => fileTreePermission(effective, files, permission, fileId)
	const read =
			holds('file:read') && ![...files.values()].some((file) => file.trashedAt),
		enabled = await fileCollaborationEnabled(env, fresh),
		write = read && enabled && holds('file:write')
	const profileId = request.credential.profileId ?? null
	const agent = request.credential.kind !== 'session'
	return {
		request: fresh,
		access: {
			read,
			write,
			comment: read && enabled && (write || holds('file:comment')),
			manage: read && holds('file:manage_access'),
		},
		actor: {
			id: agent
				? `${request.actor.userId}:agent:${profileId ?? request.credential.kind}`
				: request.actor.userId,
			personId: request.actor.userId,
			name: agent
				? `${request.actor.username ?? 'Member'}’s agent`
				: (request.actor.username ?? 'Member'),
			kind: agent ? 'agent' : 'person',
			profileId,
			runId:
				request.credential.kind === 'execution-context-run'
					? request.credential.id
					: null,
		},
	}
}
