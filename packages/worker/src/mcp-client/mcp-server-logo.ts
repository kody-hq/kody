import { toHex } from '@kody-internal/shared/hex.ts'
import { routes } from '#universal/routes.ts'
import {
	iconFitCustomMetadata,
	logoNeedsIconFit,
} from '#worker/community/icon-fit.ts'
import {
	processPlatformOauthAppLogo,
	servedFittedLogoFromBytes,
	servedLogoFromObject,
	type PlatformOauthAppLogoContentType,
	type ServedFittedLogo,
} from '#worker/integrations/platform-app-logo.ts'
import { getMcpServerSettingRowById } from './settings-repo.ts'
import type { McpServerLogoSource } from './settings-types.ts'

export const mcpServerLogoR2KeyPrefix = 'user-mcp-server-logos/'
const mcpServerLogoCacheControl = 'private, no-store'

/**
 * Relative serving path for a user-added MCP server favicon. `v` is the
 * content hash so a re-fetch busts the private cache key.
 */
export function buildMcpServerLogoPath(server: {
	id: string
	logoKey: string | null
}): string | null {
	if (!server.logoKey) return null
	const contentTag = /\/([0-9a-f]{16})[^/]*$/.exec(server.logoKey)?.[1]
	return routes.accountMcpServerLogo.href(
		{ serverId: server.id },
		contentTag ? { searchParams: { v: contentTag } } : undefined,
	)
}

export function buildMcpServerAutoLogoPath(server: {
	id: string
	logoKey?: string | null
}): string | null {
	return buildMcpServerLogoPath({
		id: server.id,
		logoKey: server.logoKey ?? null,
	})
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

export async function setMcpServerLogo(input: {
	db: D1Database
	env: Pick<Env, 'COMMUNITY_ASSETS' | 'IMAGES'>
	userId: string
	serverId: string
	sourceBytes: Uint8Array
	source: McpServerLogoSource
	faviconSourceHost: string
	/**
	 * When set, the column update is compare-and-swap on `logo_key` so a
	 * concurrent ingest cannot be overwritten by a stale lazy refit.
	 */
	replaceLogoKey?: string | null
}): Promise<void> {
	const existing = await getMcpServerSettingRowById({
		db: input.db,
		userId: input.userId,
		id: input.serverId,
	})
	if (!existing) return
	const previousKey = existing.logo_key
	const processed = await processPlatformOauthAppLogo(
		input.sourceBytes,
		input.env.IMAGES,
	)
	const contentHash = (await sha256Hex(processed.bytes)).slice(0, 16)
	const nextKey = `${mcpServerLogoR2KeyPrefix}${input.userId}/${existing.id}/${contentHash}.${extensionForContentType(processed.contentType)}`
	await input.env.COMMUNITY_ASSETS.put(nextKey, processed.bytes, {
		httpMetadata: {
			contentType: processed.contentType,
			cacheControl: mcpServerLogoCacheControl,
		},
		customMetadata: iconFitCustomMetadata({
			userId: input.userId,
			mcpServerId: existing.id,
			logoSource: input.source,
			contentHash,
		}),
	})

	const casLogoKey = input.replaceLogoKey !== undefined
	const updated = await input.db
		.prepare(
			casLogoKey
				? `UPDATE mcp_server_settings
			SET logo_key = ?, logo_content_type = ?, logo_source = ?,
				favicon_source_host = ?, updated_at = ?
			WHERE user_id = ? AND id = ? AND logo_key IS ?`
				: `UPDATE mcp_server_settings
			SET logo_key = ?, logo_content_type = ?, logo_source = ?,
				favicon_source_host = ?, updated_at = ?
			WHERE user_id = ? AND id = ?`,
		)
		.bind(
			nextKey,
			processed.contentType,
			input.source,
			input.faviconSourceHost,
			new Date().toISOString(),
			input.userId,
			existing.id,
			...(casLogoKey ? [input.replaceLogoKey] : []),
		)
		.run()

	if ((updated.meta.changes ?? 0) === 0) {
		// Leave nextKey. A concurrent writer can store the same content hash
		// after this lookup; deleting here can remove a live object.
		return
	}

	if (previousKey && previousKey !== nextKey) {
		try {
			await input.env.COMMUNITY_ASSETS.delete(previousKey)
		} catch (error) {
			console.error(
				'mcp-server-logo-previous-delete-failed',
				previousKey,
				error,
			)
		}
	}
}

export async function deleteMcpServerLogoAsset(input: {
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	logoKey: string | null
}) {
	if (!input.logoKey) return
	if (!input.logoKey.startsWith(mcpServerLogoR2KeyPrefix)) return
	try {
		await input.env.COMMUNITY_ASSETS.delete(input.logoKey)
	} catch (error) {
		console.error('mcp-server-logo-delete-failed', input.logoKey, error)
	}
}

export async function getMcpServerLogoObject(input: {
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	logoKey: string
}): Promise<R2ObjectBody | null> {
	if (!input.logoKey.startsWith(mcpServerLogoR2KeyPrefix)) return null
	return await input.env.COMMUNITY_ASSETS.get(input.logoKey)
}

export async function loadFittedMcpServerLogo(input: {
	db: D1Database
	env: Pick<Env, 'COMMUNITY_ASSETS' | 'IMAGES'>
	userId: string
	serverId: string
	logoKey: string
	logoContentType: string | null
	logoSource: McpServerLogoSource | null
	faviconSourceHost: string | null
}): Promise<ServedFittedLogo | null> {
	const object = await getMcpServerLogoObject({
		env: input.env,
		logoKey: input.logoKey,
	})
	if (!object) return await serveCurrentMcpServerLogo(input)
	if (!logoNeedsIconFit(object.customMetadata)) {
		return servedLogoFromObject(
			object,
			input.logoContentType,
			mcpServerLogoCacheControl,
		)
	}
	const sourceBytes = new Uint8Array(await object.arrayBuffer())
	try {
		await setMcpServerLogo({
			db: input.db,
			env: input.env,
			userId: input.userId,
			serverId: input.serverId,
			sourceBytes,
			source: input.logoSource ?? 'favicon',
			faviconSourceHost: input.faviconSourceHost ?? '',
			replaceLogoKey: input.logoKey,
		})
		const row = await getMcpServerSettingRowById({
			db: input.db,
			userId: input.userId,
			id: input.serverId,
		})
		if (!row?.logo_key) return null
		const fitted = await getMcpServerLogoObject({
			env: input.env,
			logoKey: row.logo_key,
		})
		if (fitted) {
			return servedLogoFromObject(
				fitted,
				row.logo_content_type,
				mcpServerLogoCacheControl,
			)
		}
	} catch (error) {
		console.error('mcp-server-logo-refit-failed', input.serverId, error)
		return servedFittedLogoFromBytes({
			bytes: sourceBytes,
			contentType: input.logoContentType,
			httpEtag: object.httpEtag,
			cacheControl: mcpServerLogoCacheControl,
		})
	}
	return await serveCurrentMcpServerLogo(input)
}

async function serveCurrentMcpServerLogo(input: {
	db: D1Database
	env: Pick<Env, 'COMMUNITY_ASSETS' | 'IMAGES'>
	userId: string
	serverId: string
	logoKey: string
}): Promise<ServedFittedLogo | null> {
	const row = await getMcpServerSettingRowById({
		db: input.db,
		userId: input.userId,
		id: input.serverId,
	})
	if (!row?.logo_key || row.logo_key === input.logoKey) return null
	const latest = await getMcpServerLogoObject({
		env: input.env,
		logoKey: row.logo_key,
	})
	if (!latest) return null
	return servedLogoFromObject(
		latest,
		row.logo_content_type,
		mcpServerLogoCacheControl,
	)
}
