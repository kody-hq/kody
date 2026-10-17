import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { memoryLegacyWriteFrozenMessage } from '#mcp/memory/memory-owner.ts'
import { deleteMemory } from '#mcp/memory/service.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

async function handleDeleteAction(input: {
	env: Env
	user: AuthenticatedUser
	memoryId: string
	force: boolean
}) {
	const memoryId = input.memoryId.trim()
	if (!memoryId) {
		return operationResult({ ok: false, error: 'Memory id is required.' }, 400)
	}
	const force = input.force
	const deleted = await deleteMemory({
		env: input.env,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		memoryId,
		force,
	})
	if (!deleted) {
		return operationResult({ ok: false, error: 'Memory not found.' }, 404)
	}
	return operationResult({ ok: true, deletedMemoryId: memoryId })
}

export async function deleteAccountMemoryRecord({
	env,
	user,
	memoryId,
	force,
}: {
	env: Env
	user: AuthenticatedUser
	memoryId: string
	force: boolean
}) {
	try {
		const ownerId = ownerIdFromCaller({
			request: user.request,
			user: user.mcpUser,
		})
		if (!(await isPersonalOrg(env.APP_DB, ownerId))) {
			return operationResult(
				{ ok: false, error: memoryLegacyWriteFrozenMessage },
				400,
			)
		}
		return await handleDeleteAction({
			env,
			user,
			memoryId,
			force,
		})
	} catch (error) {
		return operationResult(
			{
				ok: false,
				error:
					error instanceof Error ? error.message : 'Unable to update memories.',
			},
			400,
		)
	}
}
