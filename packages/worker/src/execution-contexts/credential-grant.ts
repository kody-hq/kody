import {
	ecpDefaultGrant,
	type EcpGrant,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import { ExecutionContextError } from './errors.ts'
import { type ExecutionContextRow } from './store.ts'

/**
 * The grant a newly registered context starts with. It is not shared yet, so
 * its operator's own credentialed requests may go through Kody cloud
 * (`requester`). Values still never leave Kody cloud (ADR 0083).
 */
export const registrationGrant: EcpGrant = {
	...ecpDefaultGrant,
	credentials: { mode: 'requester' },
}

/**
 * What a context run may do with credentials right now. `requester_shared`
 * is a `requester` grant on a context that is shared (or a run whose
 * requester is not the operator): it allows nothing.
 */
export type ContextRunCredentials =
	| { mode: 'none' }
	| { mode: 'list'; ids: Array<string> }
	| { mode: 'requester' }
	| { mode: 'requester_shared' }

export function contextRunCredentials(
	grant: Pick<EcpGrant, 'credentials'>,
	input: { shared: boolean; requesterIsOperator: boolean },
): ContextRunCredentials {
	const { credentials } = grant
	if (credentials.mode === 'list' && credentials.ids.length === 0) {
		return { mode: 'none' }
	}
	if (
		credentials.mode === 'requester' &&
		(input.shared || !input.requesterIsOperator)
	) {
		return { mode: 'requester_shared' }
	}
	return credentials
}

/**
 * The stable credential ids a run may resolve, enforced by the credential
 * door on every resolution. Null lets every credential the requester can use
 * through; empty lets none through.
 */
export function contextCredentialIds(
	credentials: ContextRunCredentials,
): ReadonlyArray<string> | null {
	switch (credentials.mode) {
		case 'requester':
			return null
		case 'list':
			return credentials.ids
		case 'none':
		case 'requester_shared':
			return []
	}
}

/**
 * True when anyone besides the operator can reach the context: a share to a
 * person or team in any org, everyone in its org, or an attached org.
 */
export async function contextIsShared(
	db: D1Database,
	row: Pick<ExecutionContextRow, 'id' | 'all_members'>,
) {
	if (row.all_members === 1) return true
	const [grants, attachments] = await db.batch<{ ok: number }>([
		db
			.prepare(
				`SELECT 1 AS ok FROM grants WHERE resource_type = 'execution_context' AND resource_id = ? AND deleted_at IS NULL LIMIT 1`,
			)
			.bind(row.id),
		db
			.prepare(
				`SELECT 1 AS ok FROM execution_context_org_attachments WHERE context_id = ? LIMIT 1`,
			)
			.bind(row.id),
	])
	return (
		(grants?.results.length ?? 0) > 0 || (attachments?.results.length ?? 0) > 0
	)
}

const narrowHint =
	'Narrow its credentials to an explicit list ({ mode: "list", ids: [...] }) or to none with executionContextUpdate first.'

/** Refuses sharing a context whose grant allows every requester credential. */
export function assertGrantAllowsSharing(input: {
	name: string
	grant: Pick<EcpGrant, 'credentials'>
}) {
	if (input.grant.credentials.mode !== 'requester') return
	throw new ExecutionContextError({
		status: 409,
		code: 'credentials_need_unshared_context',
		message: `${input.name} lets every credential you can use go through Kody cloud, which is allowed only while it is not shared. ${narrowHint} Then share it.`,
	})
}

/**
 * Refuses a `requester` grant on a shared context, or from anyone but the
 * operator: it lets the operator's own credentials through, nobody else's.
 */
export function assertRequesterCredentialsGrantable(input: {
	name: string
	isOperator: boolean
	shared: boolean
}) {
	if (!input.isOperator) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message: `Only ${input.name}'s operator can let their own credentials through it (credentials mode "requester").`,
		})
	}
	if (input.shared) {
		throw new ExecutionContextError({
			status: 409,
			code: 'credentials_need_unshared_context',
			message: `${input.name} is shared, so its grant cannot let every credential through (credentials mode "requester"). Use an explicit list ({ mode: "list", ids: [...] }), or stop sharing it first.`,
		})
	}
}

/** Runtime calls a context grant gates because they use a credential. */
export function isCredentialedRuntimeCall(name: string) {
	return (
		name === 'authenticatedFetch' ||
		name === 'gatewayFetch' ||
		name === 'oauthClientCredentials' ||
		name.startsWith('credentialClient')
	)
}
