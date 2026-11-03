import { toHex } from '@kody-internal/shared/hex.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import {
	normalizeUserAvatarContentType,
	userAvatarMaxAspectRatio,
	userAvatarMaxDimension,
	userAvatarMaxSourceBytes,
	userAvatarMinDimension,
	type UserAvatarOutputContentType,
} from '#universal/user-avatar-limits.ts'
import {
	assertAccountWritableDb,
	withAccountWriteLease,
} from '#worker/account/deletion-state.ts'
import type { UserMeterEnv } from '#worker/entitlements/user-meter-client.ts'
import {
	readJpegDimensions,
	readPngDimensions,
	readWebpDimensions,
} from './community-icon.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
const userAvatarR2KeyPrefix = 'user-avatars/'
const userAvatarCacheControl = 'public, max-age=31536000, immutable'

export type UserAvatarContentType = UserAvatarOutputContentType

type ProcessedUserAvatar = {
	bytes: Uint8Array
	contentType: UserAvatarContentType
}

function extensionForContentType(contentType: UserAvatarContentType) {
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

export function buildUserAvatarR2Key(input: {
	stableUserId: OwnerId
	contentHash: string
	contentType: UserAvatarContentType
}) {
	const extension = extensionForContentType(input.contentType)
	return `${userAvatarR2KeyPrefix}${input.stableUserId}/${input.contentHash}.${extension}`
}

export function parseUserAvatarCacheKey(avatarKey: string): string | null {
	const match = /^user-avatars\/[^/]+\/([^/]+)$/.exec(avatarKey)
	return match?.[1] ?? null
}

export function splitUserAvatarCacheKey(
	cacheKey: string,
): { hash: string; ext: string } | null {
	const lastDot = cacheKey.lastIndexOf('.')
	if (lastDot <= 0 || lastDot === cacheKey.length - 1) return null
	return {
		hash: cacheKey.slice(0, lastDot),
		ext: cacheKey.slice(lastDot + 1),
	}
}

function assertUserAvatarSourceSize(bytes: Uint8Array) {
	if (bytes.byteLength === 0 || bytes.byteLength > userAvatarMaxSourceBytes) {
		throw new Error(
			`Avatars must be between 1 byte and ${userAvatarMaxSourceBytes} bytes.`,
		)
	}
}

function assertUserAvatarDimensions(dimensions: {
	width: number
	height: number
}) {
	if (
		!Number.isInteger(dimensions.width) ||
		!Number.isInteger(dimensions.height) ||
		dimensions.width < userAvatarMinDimension ||
		dimensions.height < userAvatarMinDimension ||
		dimensions.width > userAvatarMaxDimension ||
		dimensions.height > userAvatarMaxDimension
	) {
		throw new Error(
			`Avatars must be between ${userAvatarMinDimension}px and ${userAvatarMaxDimension}px on each side.`,
		)
	}
	const longer = Math.max(dimensions.width, dimensions.height)
	const shorter = Math.min(dimensions.width, dimensions.height)
	if (longer / shorter > userAvatarMaxAspectRatio) {
		throw new Error(
			`Avatars must have an aspect ratio of at most ${userAvatarMaxAspectRatio}:1.`,
		)
	}
}

function readAvatarRasterDimensions(
	contentType: UserAvatarContentType,
	bytes: Uint8Array,
) {
	switch (contentType) {
		case 'image/png':
			return readPngDimensions(bytes)
		case 'image/jpeg':
			return readJpegDimensions(bytes)
		case 'image/webp':
			return readWebpDimensions(bytes)
		default: {
			const unreachable: never = contentType
			throw new Error(`Unsupported avatar content type: ${unreachable}`)
		}
	}
}

export function processUserAvatar(input: {
	contentType: string
	sourceBytes: Uint8Array
}): ProcessedUserAvatar {
	const contentType = normalizeUserAvatarContentType(input.contentType)
	if (!contentType) {
		throw new Error('Avatars must be PNG, JPEG, or WebP images.')
	}
	assertUserAvatarSourceSize(input.sourceBytes)
	const dimensions = readAvatarRasterDimensions(contentType, input.sourceBytes)
	assertUserAvatarDimensions(dimensions)
	return {
		bytes: input.sourceBytes,
		contentType,
	}
}

async function sha256Hex(bytes: Uint8Array) {
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	const digest = await crypto.subtle.digest('SHA-256', copy)
	return toHex(new Uint8Array(digest))
}

export async function saveUserAvatar(input: {
	env: Pick<Env, 'APP_DB' | 'COMMUNITY_ASSETS'> & UserMeterEnv
	numericUserId: number
	stableUserId: OwnerId
	bytes: Uint8Array
	contentType: UserAvatarContentType
}): Promise<string> {
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.stableUserId,
		env: input.env,
		async write() {
			await assertAccountWritableDb(input.env.APP_DB, input.stableUserId)
			const contentHash = await sha256Hex(input.bytes)
			const r2Key = buildUserAvatarR2Key({
				stableUserId: input.stableUserId,
				contentHash,
				contentType: input.contentType,
			})

			const existing = await input.env.APP_DB.prepare(
				`SELECT avatar_key FROM users WHERE id = ? AND stable_user_id = ?${andLiveDeletedAtSql()}`,
			)
				.bind(input.numericUserId, input.stableUserId)
				.first<{ avatar_key: string | null }>()
			const previousKey =
				existing?.avatar_key == null ? null : String(existing.avatar_key)

			await input.env.COMMUNITY_ASSETS.put(r2Key, input.bytes, {
				httpMetadata: {
					contentType: input.contentType,
					cacheControl: userAvatarCacheControl,
				},
				customMetadata: {
					stableUserId: input.stableUserId,
					contentHash,
				},
			})
			try {
				await assertAccountWritableDb(input.env.APP_DB, input.stableUserId)
			} catch (error) {
				await input.env.COMMUNITY_ASSETS.delete(r2Key)
				throw error
			}

			const update = await input.env.APP_DB.prepare(
				`UPDATE users
		SET avatar_key = ?, updated_at = ?
		WHERE id = ? AND stable_user_id = ? AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
			)
				.bind(
					r2Key,
					utcSqliteTimestamp(),
					input.numericUserId,
					input.stableUserId,
				)
				.run()
			if ((update.meta.changes ?? 0) !== 1) {
				await input.env.COMMUNITY_ASSETS.delete(r2Key)
				throw new Error(
					'Avatar write was rejected because account state changed.',
				)
			}

			if (previousKey && previousKey !== r2Key) {
				try {
					await input.env.COMMUNITY_ASSETS.delete(previousKey)
				} catch (error) {
					console.error(
						'user-avatar-previous-delete-failed',
						previousKey,
						error,
					)
				}
			}

			return r2Key
		},
	})
}

export async function deleteUserAvatar(input: {
	env: Pick<Env, 'APP_DB' | 'COMMUNITY_ASSETS'> & UserMeterEnv
	numericUserId: number
	stableUserId: OwnerId
}): Promise<void> {
	await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.stableUserId,
		env: input.env,
		async write() {
			await assertAccountWritableDb(input.env.APP_DB, input.stableUserId)
			const existing = await input.env.APP_DB.prepare(
				`SELECT avatar_key FROM users WHERE id = ? AND stable_user_id = ?${andLiveDeletedAtSql()}`,
			)
				.bind(input.numericUserId, input.stableUserId)
				.first<{ avatar_key: string | null }>()
			const previousKey =
				existing?.avatar_key == null ? null : String(existing.avatar_key)

			const update = await input.env.APP_DB.prepare(
				`UPDATE users
				SET avatar_key = NULL, updated_at = ?
				WHERE id = ? AND stable_user_id = ? AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
			)
				.bind(utcSqliteTimestamp(), input.numericUserId, input.stableUserId)
				.run()
			if ((update.meta.changes ?? 0) !== 1) {
				throw new Error(
					'Avatar delete was rejected because account state changed.',
				)
			}

			if (!previousKey) return
			try {
				await input.env.COMMUNITY_ASSETS.delete(previousKey)
			} catch (error) {
				console.error('user-avatar-delete-failed', previousKey, error)
			}
		},
	})
}

export async function getUserAvatarObject(input: {
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	avatarKey: string
}): Promise<R2ObjectBody | null> {
	if (!input.avatarKey.startsWith(userAvatarR2KeyPrefix)) {
		return null
	}
	return await input.env.COMMUNITY_ASSETS.get(input.avatarKey)
}
