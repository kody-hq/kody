import { loadBoxAccess } from './box-access.ts'
import { excessForUser } from './box-notices.ts'
import { ExecutionContextError } from './errors.ts'
import { dismissElevation } from './notices.ts'
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
