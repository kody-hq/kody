import { toHex } from '@kody-internal/shared/hex.ts'
import { routes } from '#universal/routes.ts'
import {
	iconFitCustomMetadata,
	logoNeedsIconFit,
} from '#worker/community/icon-fit.ts'
import { getOauthAppBySlug } from './repo.ts'
import {
	processPlatformOauthAppLogo,
	servedFittedLogoFromBytes,
	servedLogoFromObject,
	type PlatformOauthAppLogoContentType,
	type ServedFittedLogo,
} from './platform-app-logo.ts'
import type { UserOauthApp } from './types.ts'

export const userOauthAppLogoR2KeyPrefix = 'user-oauth-app-logos/'
const userOauthAppLogoCacheControl = 'private, no-store'

export type UserOauthAppLogoSource = 'upload' | 'favicon'

/**
 * Relative serving path for a user-lane OAuth app logo. Uses the same
 * public route as platform logos; the handler resolves the signed-in
 * user's app after a platform miss. `v` is the content hash.
 */
export function buildUserOauthAppLogoPath(app: {
	slug: string
	logoKey: string | null
}): string | null {
	if (!app.logoKey) return null
	const contentTag = /\/([0-9a-f]{16})[^/]*$/.exec(app.logoKey)?.[1]
	return routes.integrationLogo.href(
		{ integrationSlug: app.slug },
		contentTag ? { searchParams: { v: contentTag } } : undefined,
	)
}

export function buildUserOauthAppLogoPaths(app: {
	slug: string
	logoKey?: string | null
	logoSource?: UserOauthAppLogoSource | null
}): { logoPath: string | null; autoLogoPath: string | null } {
	const path = buildUserOauthAppLogoPath({
		slug: app.slug,
		logoKey: app.logoKey ?? null,
	})
	if (!path || !app.logoSource) {
		return { logoPath: null, autoLogoPath: null }
	}
	if (app.logoSource === 'upload') {
		return { logoPath: path, autoLogoPath: null }
	}
	return { logoPath: null, autoLogoPath: path }
}

function extensionForContentType(contentType: PlatformOauthAppLogoContentType) {
	switch (contentType) {
		case 'image/png':
			return 'png'
		case 'image/jpeg':
			return 'jpg'
		case 'image/webp':
			return 'webp'
		default: {
			const unreachable: never = contentType
			throw new Error(`Unsupported logo content type: ${unreachable}`)
		}
	}
}

async function sha256Hex(bytes: Uint8Array) {
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	const digest = await crypto.subtle.digest('SHA-256', copy)
	return toHex(new Uint8Array(digest))
}

export async function setUserOauthAppLogo(input: {
	db: D1Database
	env: Pick<Env, 'COMMUNITY_ASSETS' | 'IMAGES'>
	userId: string
	slug: string
	sourceBytes: Uint8Array | null
	source: UserOauthAppLogoSource
	faviconSourceHost?: string | null
	/**
	 * When set, the column update is compare-and-swap on `logo_key` so a
	 * concurrent ingest cannot be overwritten by a stale lazy refit.
	 */
	replaceLogoKey?: string | null
}): Promise<UserOauthApp> {
	const app = await getOauthAppBySlug({
		db: input.db,
		userId: input.userId,
		slug: input.slug,
	})
	if (!app) {
		throw new Error(`OAuth app "${input.slug}" was not found.`)
	}
	// Favicon fill is async; a user upload that lands while we are fetching
	// must win. Re-read happens here so the write itself is the guard.
	if (
		input.source === 'favicon' &&
		app.logoSource === 'upload' &&
		app.logoKey
	) {
		return app
	}
	const previousKey = app.logoKey

	let nextKey: string | null = null
	let nextContentType: PlatformOauthAppLogoContentType | null = null
	let nextSource: UserOauthAppLogoSource | null = null
	let nextFaviconHost: string | null = null
	if (input.sourceBytes) {
		const processed = await processPlatformOauthAppLogo(
			input.sourceBytes,
			input.env.IMAGES,
		)
		const contentHash = (await sha256Hex(processed.bytes)).slice(0, 16)
		nextKey = `${userOauthAppLogoR2KeyPrefix}${input.userId}/${app.slug}/${contentHash}.${extensionForContentType(processed.contentType)}`
		nextContentType = processed.contentType
		nextSource = input.source
		nextFaviconHost =
			input.source === 'favicon' ? (input.faviconSourceHost ?? null) : null
		await input.env.COMMUNITY_ASSETS.put(nextKey, processed.bytes, {
			httpMetadata: {
				contentType: processed.contentType,
				cacheControl: userOauthAppLogoCacheControl,
			},
			customMetadata: iconFitCustomMetadata({
				userId: input.userId,
				userAppSlug: app.slug,
				logoSource: input.source,
				contentHash,
			}),
		})
	}

	const casLogoKey = input.replaceLogoKey !== undefined
	let updateSql = `UPDATE user_oauth_apps
			SET logo_key = ?, logo_content_type = ?, logo_source = ?,
				favicon_source_host = ?, updated_at = ?
			WHERE user_id = ? AND slug = ?`
	if (input.source === 'favicon') {
		updateSql += `
				AND (logo_source IS NULL OR logo_source <> 'upload')`
	}
	if (casLogoKey) {
		updateSql += `
				AND logo_key IS ?`
	}
	const updated = await input.db
		.prepare(updateSql)
		.bind(
			nextKey,
			nextContentType,
			nextSource,
			nextFaviconHost,
			new Date().toISOString(),
			input.userId,
			app.slug,
			...(casLogoKey ? [input.replaceLogoKey] : []),
		)
		.run()

	if ((updated.meta.changes ?? 0) === 0) {
		// Leave nextKey. A concurrent writer can store the same content hash
		// after this lookup; deleting here can remove a live object.
		return (
			(await getOauthAppBySlug({
				db: input.db,
				userId: input.userId,
				slug: app.slug,
			})) ?? app
		)
	}

	if (previousKey && previousKey !== nextKey) {
		try {
			await input.env.COMMUNITY_ASSETS.delete(previousKey)
		} catch (error) {
			console.error(
				'user-oauth-app-logo-previous-delete-failed',
				previousKey,
				error,
			)
		}
	}

	const saved = await getOauthAppBySlug({
		db: input.db,
		userId: input.userId,
		slug: app.slug,
	})
	if (!saved) {
		throw new Error(`OAuth app "${app.slug}" disappeared during logo update.`)
	}
	return saved
}

export async function deleteUserOauthAppLogoAsset(input: {
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	logoKey: string | null
}) {
	if (!input.logoKey) return
	if (!input.logoKey.startsWith(userOauthAppLogoR2KeyPrefix)) return
	try {
		await input.env.COMMUNITY_ASSETS.delete(input.logoKey)
	} catch (error) {
		console.error('user-oauth-app-logo-delete-failed', input.logoKey, error)
	}
}

export async function getUserOauthAppLogoObject(input: {
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	logoKey: string
}): Promise<R2ObjectBody | null> {
	if (!input.logoKey.startsWith(userOauthAppLogoR2KeyPrefix)) return null
	return await input.env.COMMUNITY_ASSETS.get(input.logoKey)
}

export async function loadFittedUserOauthAppLogo(input: {
	db: D1Database
	env: Pick<Env, 'COMMUNITY_ASSETS' | 'IMAGES'>
	userId: string
	app: UserOauthApp
}): Promise<ServedFittedLogo | null> {
	if (!input.app.logoKey) return null
	const object = await getUserOauthAppLogoObject({
		env: input.env,
		logoKey: input.app.logoKey,
	})
	if (!object) return await serveCurrentUserOauthAppLogo(input)
	if (!logoNeedsIconFit(object.customMetadata)) {
		return servedLogoFromObject(
			object,
			input.app.logoContentType,
			userOauthAppLogoCacheControl,
		)
	}
	const sourceBytes = new Uint8Array(await object.arrayBuffer())
	try {
		const updated = await setUserOauthAppLogo({
			db: input.db,
			env: input.env,
			userId: input.userId,
			slug: input.app.slug,
			sourceBytes,
			source: input.app.logoSource ?? 'upload',
			faviconSourceHost: input.app.faviconSourceHost,
			replaceLogoKey: input.app.logoKey,
		})
		if (!updated.logoKey) return null
		const fitted = await getUserOauthAppLogoObject({
			env: input.env,
			logoKey: updated.logoKey,
		})
		if (fitted) {
			return servedLogoFromObject(
				fitted,
				updated.logoContentType,
				userOauthAppLogoCacheControl,
			)
		}
	} catch (error) {
		console.error('user-oauth-app-logo-refit-failed', input.app.slug, error)
		return servedFittedLogoFromBytes({
			bytes: sourceBytes,
			contentType: input.app.logoContentType,
			httpEtag: object.httpEtag,
			cacheControl: userOauthAppLogoCacheControl,
		})
	}
	return await serveCurrentUserOauthAppLogo(input)
}

async function serveCurrentUserOauthAppLogo(input: {
	db: D1Database
	env: Pick<Env, 'COMMUNITY_ASSETS' | 'IMAGES'>
	userId: string
	app: UserOauthApp
}): Promise<ServedFittedLogo | null> {
	const current = await getOauthAppBySlug({
		db: input.db,
		userId: input.userId,
		slug: input.app.slug,
	})
	if (!current?.logoKey || current.logoKey === input.app.logoKey) return null
	const latest = await getUserOauthAppLogoObject({
		env: input.env,
		logoKey: current.logoKey,
	})
	if (!latest) return null
	return servedLogoFromObject(
		latest,
		current.logoContentType,
		userOauthAppLogoCacheControl,
	)
}
