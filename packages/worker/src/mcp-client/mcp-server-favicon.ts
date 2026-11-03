import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	fetchFaviconBytes,
	resolveFaviconOrigin,
} from '#worker/integrations/user-oauth-app-favicon.ts'
import { setMcpServerLogo } from './mcp-server-logo.ts'
import { getMcpServerSettingRowById } from './settings-repo.ts'
import type { McpServerSettingMetadata } from './settings-types.ts'

const maxBackfillPerPage = 5

export function shouldFetchMcpServerFavicon(
	server: Pick<
		McpServerSettingMetadata,
		'url' | 'logoKey' | 'logoSource' | 'faviconSourceHost'
	>,
): boolean {
	const resolved = resolveFaviconOrigin([server.url])
	if (!resolved) return false
	if (server.logoSource === 'favicon' && server.logoKey) {
		return server.faviconSourceHost !== resolved.host
	}
	return true
}

export async function fillMcpServerFavicon(input: {
	db: D1Database
	env: Pick<Env, 'COMMUNITY_ASSETS' | 'IMAGES'>
	userId: string
	serverId: string
}): Promise<void> {
	const row = await getMcpServerSettingRowById({
		db: input.db,
		userId: input.userId,
		id: input.serverId,
	})
	if (!row) return
	const server = {
		url: row.url,
		logoKey: row.logo_key,
		logoSource: row.logo_source,
		faviconSourceHost: row.favicon_source_host,
	}
	if (!shouldFetchMcpServerFavicon(server)) return
	const resolved = resolveFaviconOrigin([row.url])
	if (!resolved) return
	const bytes = await fetchFaviconBytes({
		origin: resolved.origin,
	})
	if (!bytes) return
	try {
		await setMcpServerLogo({
			db: input.db,
			env: input.env,
			userId: input.userId,
			serverId: row.id,
			sourceBytes: bytes,
			source: 'favicon',
			faviconSourceHost: resolved.host,
		})
	} catch (error) {
		console.error(
			'mcp-server-favicon-store-failed',
			row.id,
			getErrorMessage(error),
		)
	}
}

export async function scheduleMcpServerFaviconFill(input: {
	db: D1Database
	env: Pick<Env, 'APP_DB' | 'COMMUNITY_ASSETS' | 'IMAGES'> | Pick<Env, 'APP_DB'>
	userId: string
	serverId: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	if (
		!('COMMUNITY_ASSETS' in input.env) ||
		!input.env.COMMUNITY_ASSETS ||
		!('IMAGES' in input.env) ||
		!input.env.IMAGES
	) {
		return
	}
	const env = input.env as Pick<Env, 'APP_DB' | 'COMMUNITY_ASSETS' | 'IMAGES'>
	const work = fillMcpServerFavicon({
		db: input.db,
		env,
		userId: input.userId,
		serverId: input.serverId,
	}).catch((error: unknown) => {
		console.error(
			'mcp-server-favicon-fill-failed',
			input.serverId,
			getErrorMessage(error),
		)
	})
	if (input.waitUntil) {
		input.waitUntil(work)
		return
	}
	await work
}

export async function backfillMissingMcpServerFavicons(input: {
	db: D1Database
	env: Pick<Env, 'APP_DB' | 'COMMUNITY_ASSETS' | 'IMAGES'> | Pick<Env, 'APP_DB'>
	userId: string
	servers: Array<McpServerSettingMetadata>
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	if (
		!('COMMUNITY_ASSETS' in input.env) ||
		!input.env.COMMUNITY_ASSETS ||
		!('IMAGES' in input.env) ||
		!input.env.IMAGES
	) {
		return
	}
	const pending = input.servers
		.filter((server) => shouldFetchMcpServerFavicon(server))
		.slice(0, maxBackfillPerPage)
	if (pending.length === 0) return
	const env = input.env as Pick<Env, 'APP_DB' | 'COMMUNITY_ASSETS' | 'IMAGES'>
	const work = (async () => {
		for (const server of pending) {
			await fillMcpServerFavicon({
				db: input.db,
				env,
				userId: input.userId,
				serverId: server.id,
			}).catch((error: unknown) => {
				console.error(
					'mcp-server-favicon-backfill-failed',
					server.id,
					getErrorMessage(error),
				)
			})
		}
	})()
	if (input.waitUntil) {
		input.waitUntil(work)
		return
	}
	await work
}
