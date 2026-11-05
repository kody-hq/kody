import { loadBoxAccess } from './box-access.ts'
import { excessForUser } from './box-notices.ts'
import { ExecutionContextError } from './errors.ts'
import { dismissElevation } from './notices.ts'
import { recordAcknowledgment } from './acknowledgments.ts'
import { type ExecutionContextCaller, loadVisibleContext } from './service.ts'
import { canManageContext } from './store.ts'

/** Only the person a notice is about dismisses it, and never as a profile. */
export async function dismissContextNotice(
	caller: ExecutionContextCaller,
	ref: string,
	fingerprint: string,
) {
	if (caller.request.credential.profileId) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message:
				'Only the person a notice is about can dismiss it, signed in as themselves (not as an agent profile).',
		})
	}
	const { row } = await loadVisibleContext(caller, ref)
	const result = await dismissElevation(caller.env.APP_DB, {
		contextId: row.id,
		orgId: caller.orgId,
		userId: caller.userId,
		fingerprint,
	})
	if (result === 'changed') {
		throw new ExecutionContextError({
			status: 409,
			code: 'invalid_request',
			message:
				'That notice changed since you saw it. Read the context again and dismiss the current one.',
		})
	}
	return { dismissed: result === 'dismissed' }
}

/** What sharing with these people would give them beyond their own access. */
export async function previewShare(
	caller: ExecutionContextCaller,
	ref: string,
	userIds: ReadonlyArray<string>,
) {
	const { row, access } = await loadVisibleContext(caller, ref)
	if (!canManageContext(access)) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message:
				'Only the operator or someone with Manage on this context can preview a share.',
		})
	}
	const db = caller.env.APP_DB
	const box = await loadBoxAccess(db, row, caller.orgId)
	const people = await Promise.all(
		userIds.slice(0, 200).map(async (userId) => ({
			userId,
			excess: await excessForUser(db, box, caller.orgId, userId),
		})),
	)
	// People past the cap are unchecked; callers treat them as possible excess.
	return {
		box: box.principal,
		people,
		unchecked: Math.max(0, userIds.length - people.length),
	}
}

/**
 * Records what a shared context runs as, as the person themselves: a web
 * session or their own CLI login, never an agent profile, API token or MCP
 * client (ADR 0097).
 */
export async function acknowledgeContext(
	caller: ExecutionContextCaller,
	ref: string,
	fingerprint: string,
) {
	const credential = caller.request.credential
	if (
		credential.profileId ||
		(credential.kind !== 'session' && credential.kind !== 'cli')
	) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message:
				'Only you can acknowledge an execution context, signed in as yourself: choose Acknowledge on its page in Kody, or run `kody context acknowledge <name>` in a terminal. Agents, agent profiles and API tokens cannot.',
		})
	}
	const { row, access } = await loadVisibleContext(caller, ref)
	if (!access.granted && !access.isOperator) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message: 'This execution context is not shared with you.',
		})
	}
	const result = await recordAcknowledgment(caller.env.APP_DB, {
		row,
		orgId: caller.orgId,
		userId: caller.userId,
		fingerprint,
	})
	if (result === 'changed') {
		throw new ExecutionContextError({
			status: 409,
			code: 'invalid_request',
			message:
				'What this machine runs as changed since you read it. Read the context again and acknowledge the current version.',
		})
	}
	return { acknowledged: true, alreadyCurrent: result === 'not_required' }
}
