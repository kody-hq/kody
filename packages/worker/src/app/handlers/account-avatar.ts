import { buildUserAvatarUrl } from '#app/community-public.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	deleteUserAvatar,
	processUserAvatar,
	saveUserAvatar,
} from '#worker/community/avatar.ts'
import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'

async function readFileBytes(file: File): Promise<Uint8Array> {
	return new Uint8Array(await file.arrayBuffer())
}

export async function updateAccountAvatar({
	env,
	user,
	request,
	avatar,
}: {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	request: Request
	avatar: File | null
}) {
	// Avatars belong to the person, not their personal org.
	const stableUserId = personalOrgId(user.mcpUser.userId)
	let avatarKey: string | null = null
	if (avatar === null)
		await deleteUserAvatar({ env, numericUserId: user.userId, stableUserId })
	else {
		if (avatar.size === 0) throw new Error('Avatar file is required.')
		const processed = processUserAvatar({
			contentType: avatar.type || 'application/octet-stream',
			sourceBytes: await readFileBytes(avatar),
		})
		avatarKey = await saveUserAvatar({
			env,
			numericUserId: user.userId,
			stableUserId,
			bytes: processed.bytes,
			contentType: processed.contentType,
		})
	}
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'account',
		action: avatar === null ? 'delete_avatar' : 'upload_avatar',
		result: 'success',
		email: user.email,
		ip: getRequestIp(request) ?? undefined,
		path: '/account',
	})
	return {
		ok: true as const,
		avatarUrl: buildUserAvatarUrl({ username: user.username, avatarKey }),
	}
}
