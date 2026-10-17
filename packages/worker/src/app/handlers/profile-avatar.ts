import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	getUserAvatarObject,
	parseUserAvatarCacheKey,
} from '#worker/community/avatar.ts'
import { getUserSocialRowByUsername } from '#worker/community/profile-repo.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'

const publicUserAvatarCacheControl = 'public, max-age=31536000, immutable'
const privateUserAvatarCacheControl = 'private, no-store'

export function createProfileAvatarHandler(env: Env) {
	return async ({
		request,
		params,
	}: {
		request: Request
		params: { username: string; hash: string; ext: string }
	}) => {
		const row = await getUserSocialRowByUsername(env.APP_DB, params.username)
		if (!row?.avatar_key) {
			return new Response('Not found', { status: 404 })
		}

		const cacheKey = parseUserAvatarCacheKey(row.avatar_key)
		if (!cacheKey || cacheKey !== `${params.hash}.${params.ext}`) {
			return new Response('Not found', { status: 404 })
		}

		const isPublic = row.profile_visibility === 'public'
		if (!isPublic) {
			const user = await readAuthenticatedAppUser(request, env)
			const ownerStableId = ownerIdFromStored(row.stable_user_id)
			if (!user || user.request.org.id !== ownerStableId) {
				return new Response('Not found', { status: 404 })
			}
		}

		const object = await getUserAvatarObject({
			env,
			avatarKey: row.avatar_key,
		})
		if (!object) {
			return new Response('Not found', { status: 404 })
		}

		const contentType =
			object.httpMetadata?.contentType ?? 'application/octet-stream'
		const headers: Record<string, string> = {
			'Cache-Control': isPublic
				? publicUserAvatarCacheControl
				: privateUserAvatarCacheControl,
			'Content-Type': contentType,
			'X-Content-Type-Options': 'nosniff',
		}
		if (object.size != null) {
			headers['Content-Length'] = String(object.size)
		}
		if (object.httpEtag) {
			headers.ETag = object.httpEtag
		}

		return new Response(object.body, { headers })
	}
}
