import {
	fileCollaborationEnabled,
	fileEffectivePermissions,
} from './feature.ts'
import { fileTreePermission, loadFileAncestors } from './tree-access.ts'
import { fileStoreRpc } from './client.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { loadLiveOrgBindingForOrg } from '#worker/orgs/repo.ts'
import type {
	CollaborationAccess,
	CollaborationActor,
} from '#universal/file-collaboration.ts'

/**
 * Person/org lookups shared across access checks within one handler run, so
 * sockets that belong to the same person in the same org reuse one D1 lookup.
 * Callers must start a fresh cache per run so revocations are still observed.
 */
export type FileAccessLookups = Map<string, Promise<unknown>>

function memo<T>(
	lookups: FileAccessLookups | undefined,
	key: string,
	load: () => Promise<T>,
): Promise<T> {
	if (!lookups) return load()
	let value = lookups.get(key) as Promise<T> | undefined
	if (!value) {
		value = load()
		lookups.set(key, value)
	}
	return value
}

/** Room callers supply server-derived contexts. Never accept one from client JSON. */
export async function fileCollaborationAccess(
	env: Env,
	request: RequestContext,
	fileId: string,
	lookups?: FileAccessLookups,
): Promise<{
	request: RequestContext
	access: CollaborationAccess
	actor: CollaborationActor
}> {
	if (!request.actor) throw new Error('Sign in to open this file.')
	const personOrg = JSON.stringify([request.actor.userId, request.org.id])
	const binding = await memo(lookups, `binding:${personOrg}`, () =>
		loadLiveOrgBindingForOrg(env.APP_DB, request.actor!.userId, request.org.id),
	)
	if (!binding) throw new Error('File access was revoked.')
	const fresh = {
		...request,
		membership: binding.role ? { role: binding.role } : null,
	}
	// Evaluated once per person/org and reused for both effective permissions
	// and the collaboration gates below.
	let enabledOnce: Promise<boolean> | undefined
	const enabledLookup = () =>
		(enabledOnce ??= memo(lookups, `enabled:${personOrg}`, () =>
			fileCollaborationEnabled(env, fresh),
		))
	const effective = await fileEffectivePermissions(env, fresh, enabledLookup)
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
		enabled = await enabledLookup(),
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
