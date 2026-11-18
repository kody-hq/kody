import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import type { NxCacheEnv, NxCacheStore } from './nx-cache-types.ts'

// Nx task hashes are decimal u64 strings, so short ones (15 digits or
// fewer) are valid too.
const HASH_PATTERN = /^[a-fA-F0-9]{1,128}$/
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024

function readBearerToken(request: Request): string | null {
	const header = request.headers.get('authorization')
	if (!header) return null
	const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
	return match?.[1] ?? null
}

export function parseCacheHash(pathname: string): string | null {
	const match = /^\/v1\/cache\/([^/]+)$/.exec(pathname)
	if (!match?.[1]) return null
	if (!HASH_PATTERN.test(match[1])) return null
	return match[1]
}

function plainText(status: number, message: string): Response {
	return new Response(message, {
		status,
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	})
}

type CacheAuthorization =
	| { ok: true; canWrite: boolean }
	| { ok: false; response: Response }

async function authorizeCacheRequest(
	request: Request,
	tokens: { write?: string; read?: string },
): Promise<CacheAuthorization> {
	const write = tokens.write?.trim() ?? ''
	if (!write) {
		return {
			ok: false,
			response: plainText(503, 'Nx cache is not configured'),
		}
	}
	const read = tokens.read?.trim() ?? ''
	if (read && (await timingSafeEqualString(write, read))) {
		return {
			ok: false,
			response: plainText(503, 'Nx cache tokens are misconfigured'),
		}
	}
	const bearer = readBearerToken(request)
	if (bearer === null) {
		return { ok: false, response: plainText(401, 'Unauthorized') }
	}
	const writeMatch = await timingSafeEqualString(bearer, write)
	const readMatch = read ? await timingSafeEqualString(bearer, read) : false
	if (writeMatch) return { ok: true, canWrite: true }
	if (readMatch) return { ok: true, canWrite: false }
	return { ok: false, response: plainText(401, 'Unauthorized') }
}

export async function handleNxCacheRequest(
	request: Request,
	env: Pick<
		NxCacheEnv,
		'CACHE_ACCESS_TOKEN' | 'CACHE_READ_TOKEN' | 'BUILD_COMMIT'
	>,
	store: NxCacheStore,
): Promise<Response> {
	const url = new URL(request.url)
	if (url.pathname === '/health') {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return plainText(405, 'Method not allowed')
		}
		return Response.json(
			{ ok: true, commit: env.BUILD_COMMIT ?? null },
			{ headers: { 'Cache-Control': 'no-store' } },
		)
	}

	const hash = parseCacheHash(url.pathname)
	if (!hash) {
		return plainText(404, 'Not found')
	}

	const authorization = await authorizeCacheRequest(request, {
		write: env.CACHE_ACCESS_TOKEN,
		read: env.CACHE_READ_TOKEN,
	})
	if (!authorization.ok) return authorization.response

	if (request.method === 'GET') {
		const object = await store.get(hash)
		if (!object) return plainText(404, 'The record was not found')
		return new Response(object.body, {
			status: 200,
			headers: {
				'Content-Type': 'application/octet-stream',
				'Content-Length': String(object.size),
			},
		})
	}

	if (request.method === 'PUT') {
		if (!authorization.canWrite) {
			return plainText(403, 'Read-only token cannot write')
		}
		const contentLengthHeader = request.headers.get('content-length')
		if (!contentLengthHeader) {
			return plainText(400, 'Content-Length is required')
		}
		const contentLength = Number(contentLengthHeader)
		if (!Number.isInteger(contentLength) || contentLength < 0) {
			return plainText(400, 'Content-Length is invalid')
		}
		if (contentLength > MAX_ARTIFACT_BYTES) {
			return plainText(413, 'Artifact exceeds 100MB limit')
		}
		if (!request.body) {
			return plainText(400, 'Request body is required')
		}
		const result = await store.putIfAbsent(hash, request.body)
		if (result === 'exists') {
			return plainText(409, 'Cannot override an existing record')
		}
		return new Response(null, { status: 200 })
	}

	return plainText(405, 'Method not allowed')
}
