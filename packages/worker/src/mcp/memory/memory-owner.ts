/**
 * Memory is personal-only (ADR 0072). Storage and MCP tools always use the
 * acting person's personal org, regardless of which org the connection is bound
 * to. Team-org `mcp_memories` rows are legacy: readable until cleanup, not
 * writable.
 */
import type {
	OwnerId,
	PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'

export const memoryLegacyWriteFrozenMessage =
	'Memory is personal-only. Write or delete only in your personal org. Shared org knowledge belongs in documented packages and org instructions.'

export const memoryLegacyGrantBlockedMessage =
	'Memory is personal-only. New memory grants are only allowed on a personal org. Shared org knowledge belongs in documented packages and org instructions.'

/** Provenance URI stamped on every migrated copy (stable, queryable). */
export function legacyOrgMemoryProvenanceUri(
	fromOrgId: string,
	sourceMemoryId: string,
) {
	return `https://kody.codes/legacy-org-memory/${fromOrgId}/${sourceMemoryId}`
}

export function personalMemoryOwnerId(user: {
	userId: PersonId
	personalOrgId?: OwnerId | null
}): OwnerId {
	return personalOrgIdForPerson(user)
}

/**
 * Request context rebound to the actor's personal org so `authorize` checks
 * personal ownership and token scopes, not the connection's team org.
 */
export function personalMemoryOwnerRequest(input: {
	request: RequestContext
	userId: PersonId
	/** Prefer stamped personal org when the caller loaded `users.personal_org_id`. */
	personalOrgId?: OwnerId | null
}): RequestContext {
	const personalId = personalMemoryOwnerId({
		userId: input.userId,
		personalOrgId: input.personalOrgId,
	})
	if (input.request.org.id === personalId) return input.request
	return {
		...input.request,
		org: {
			id: personalId,
			slug: input.request.actor?.username ?? input.request.org.slug,
		},
		membership: { role: 'owner' },
	}
}

export async function assertPersonalMemoryWritable(
	db: D1Database,
	ownerId: OwnerId,
) {
	if (await isPersonalOrg(db, ownerId)) return
	throw new McpCallerError(memoryLegacyWriteFrozenMessage)
}

export async function assertMemoryGrantsAllowedOnOrg(
	db: D1Database,
	orgId: OwnerId,
) {
	if (await isPersonalOrg(db, orgId)) return
	throw new McpCallerError(memoryLegacyGrantBlockedMessage)
}
