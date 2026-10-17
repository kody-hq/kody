import { adminOperationResult } from './operation-result.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	addReservedUsernames,
	InvalidReservedUsernameError,
	PermanentlyReservedUsernameError,
	removeReservedUsernames,
} from '#worker/identity/reserved-username-settings.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'

type ReservedUsernamesInput = {
	env: Env
	request: Request
	usernames: string[]
}
export async function addAdminReservedUsernames(input: ReservedUsernamesInput) {
	const actor = await requireUserWithRole(input.request, input.env, 'admin')
	return updateReservedUsernames({ ...input, actor, kind: 'add' })
}
export async function removeAdminReservedUsernames(
	input: ReservedUsernamesInput,
) {
	const actor = await requireUserWithRole(input.request, input.env, 'admin')
	return updateReservedUsernames({ ...input, actor, kind: 'remove' })
}

async function updateReservedUsernames(input: {
	env: Env
	request: Request
	actor: Awaited<ReturnType<typeof requireUserWithRole>>
	usernames: string[]
	kind: 'add' | 'remove'
}) {
	const usernames = input.usernames
	try {
		if (input.kind === 'add') {
			await addReservedUsernames({
				env: input.env,
				usernames,
				updatedBy: input.actor.mcpUser.userId,
			})
		} else {
			await removeReservedUsernames({
				env: input.env,
				usernames,
				updatedBy: input.actor.mcpUser.userId,
			})
		}
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: 'Unable to update reserved usernames.'
		const status =
			error instanceof PermanentlyReservedUsernameError ||
			error instanceof InvalidReservedUsernameError ||
			(error instanceof Error &&
				error.message === 'Provide at least one username.')
				? 400
				: 500
		return adminOperationResult({ ok: false, error: message }, status)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action:
			input.kind === 'add'
				? 'reserved_username_add'
				: 'reserved_username_remove',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: '/admin/reserved-usernames',
		reason: `usernames=${usernames.join(',')}`,
	})

	return adminOperationResult({ ok: true as const })
}
