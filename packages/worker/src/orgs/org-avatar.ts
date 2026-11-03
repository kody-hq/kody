import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { routes } from '#universal/routes.ts'
import type { UserAvatarOutputContentType } from '#universal/user-avatar-limits.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

const orgAvatarR2KeyPrefix = 'org-avatars/'
const orgAvatarCacheControl = 'public, max-age=31536000, immutable'

function extensionForContentType(contentType: UserAvatarOutputContentType) {
	switch (contentType) {
		case 'image/png':
			return 'png'
		case 'image/jpeg':
			return 'jpg'
		case 'image/webp':
			return 'webp'
		default: {
			const unreachable: never = contentType
			throw new Error(`Unsupported avatar content type: ${unreachable}`)
		}
	}
}

/** R2 listing prefix for every avatar object owned by one org. */
export function orgAvatarR2OrgPrefix(orgId: string) {
	return `${orgAvatarR2KeyPrefix}${orgId}/`
}

export function buildOrgAvatarR2Key(input: {
	orgId: string
	contentHash: string
	contentType: UserAvatarOutputContentType
}) {
	const extension = extensionForContentType(input.contentType)
	return `${orgAvatarR2OrgPrefix(input.orgId)}${input.contentHash}.${extension}`
}

export function parseOrgAvatarCacheKey(avatarKey: string): string | null {
	const match = /^org-avatars\/[^/]+\/([^/]+)$/.exec(avatarKey)
	return match?.[1] ?? null
}

export function splitOrgAvatarCacheKey(
	cacheKey: string,
): { hash: string; ext: string } | null {
	const lastDot = cacheKey.lastIndexOf('.')
	if (lastDot <= 0 || lastDot === cacheKey.length - 1) return null
	return {
		hash: cacheKey.slice(0, lastDot),
		ext: cacheKey.slice(lastDot + 1),
	}
}

export function buildOrgAvatarUrl(input: {
	slug: string
	avatarKey: string | null
}): string | null {
	if (!input.avatarKey) return null
	const cacheKey = parseOrgAvatarCacheKey(input.avatarKey)
	if (!cacheKey) return null
	const parts = splitOrgAvatarCacheKey(cacheKey)
	if (!parts) return null
	return routes.orgAvatar.href({
		orgSlug: input.slug,
		hash: parts.hash,
		ext: parts.ext,
	})
}

async function sha256Hex(bytes: Uint8Array) {
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	const digest = await crypto.subtle.digest('SHA-256', copy)
	return toHex(new Uint8Array(digest))
}

export async function saveOrgAvatar(input: {
	env: Pick<Env, 'APP_DB' | 'COMMUNITY_ASSETS'>
	orgId: string
	bytes: Uint8Array
	contentType: UserAvatarOutputContentType
}): Promise<string> {
	const contentHash = await sha256Hex(input.bytes)
	const r2Key = buildOrgAvatarR2Key({
		orgId: input.orgId,
		contentHash,
		contentType: input.contentType,
	})
	const existing = await input.env.APP_DB.prepare(
		`SELECT avatar_key FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(input.orgId)
		.first<{ avatar_key: string | null }>()
	if (!existing) {
		throw new Error('Organization was not found.')
	}
	const previousKey =
		existing.avatar_key == null ? null : String(existing.avatar_key)

	await input.env.COMMUNITY_ASSETS.put(r2Key, input.bytes, {
		httpMetadata: {
			contentType: input.contentType,
			cacheControl: orgAvatarCacheControl,
		},
		customMetadata: {
			orgId: input.orgId,
			contentHash,
		},
	})

	const update = await input.env.APP_DB.prepare(
		`UPDATE orgs
		 SET avatar_key = ?, updated_at = ?
		 WHERE id = ? AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
	)
		.bind(r2Key, utcSqliteTimestamp(), input.orgId)
		.run()
	if ((update.meta.changes ?? 0) !== 1) {
		await input.env.COMMUNITY_ASSETS.delete(r2Key)
		throw new Error(
			'Avatar write was rejected because organization state changed.',
		)
	}

	if (previousKey && previousKey !== r2Key) {
		try {
			await input.env.COMMUNITY_ASSETS.delete(previousKey)
		} catch (error) {
			console.error('org-avatar-previous-delete-failed', previousKey, error)
		}
	}

	return r2Key
}

export async function deleteOrgAvatar(input: {
	env: Pick<Env, 'APP_DB' | 'COMMUNITY_ASSETS'>
	orgId: string
}): Promise<void> {
	const existing = await input.env.APP_DB.prepare(
		`SELECT avatar_key FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(input.orgId)
		.first<{ avatar_key: string | null }>()
	if (!existing) {
		throw new Error('Organization was not found.')
	}
	const previousKey =
		existing.avatar_key == null ? null : String(existing.avatar_key)

	const update = await input.env.APP_DB.prepare(
		`UPDATE orgs
		 SET avatar_key = NULL, updated_at = ?
		 WHERE id = ? AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
	)
		.bind(utcSqliteTimestamp(), input.orgId)
		.run()
	if ((update.meta.changes ?? 0) !== 1) {
		throw new Error(
			'Avatar delete was rejected because organization state changed.',
		)
	}

	if (!previousKey) return
	try {
		await input.env.COMMUNITY_ASSETS.delete(previousKey)
	} catch (error) {
		console.error('org-avatar-delete-failed', previousKey, error)
	}
}

export async function getOrgAvatarObject(input: {
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	avatarKey: string
}): Promise<R2ObjectBody | null> {
	if (!input.avatarKey.startsWith(orgAvatarR2KeyPrefix)) {
		return null
	}
	return await input.env.COMMUNITY_ASSETS.get(input.avatarKey)
}
