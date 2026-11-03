import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http'

import { handleNxCacheRequest, MAX_ARTIFACT_BYTES } from './handle-request.ts'
import { createMemoryCacheStore } from './memory-store.ts'
import type { NxCacheStore } from './nx-cache-types.ts'

type NxCacheRequestLog = {
	method: string
	pathname: string
	status: number
}

export type LocalNxCacheServer = {
	url: string
	token: string
	store: NxCacheStore
	requests: Array<NxCacheRequestLog>
	close(): Promise<void>
}

class PayloadTooLargeError extends Error {
	constructor() {
		super('payload too large')
		this.name = 'PayloadTooLargeError'
	}
}

function collectBody(
	request: IncomingMessage,
	maxBytes: number,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Array<Buffer> = []
		let size = 0
		const onData = (chunk: Buffer) => {
			size += chunk.length
			if (size > maxBytes) {
				request.off('data', onData)
				request.destroy()
				reject(new PayloadTooLargeError())
				return
			}
			chunks.push(chunk)
		}
		request.on('data', onData)
		request.on('end', () => {
			resolve(Buffer.concat(chunks))
		})
		request.on('error', reject)
	})
}

function headersFromIncoming(request: IncomingMessage): Headers {
	const headers = new Headers()
	for (const [name, value] of Object.entries(request.headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(name, entry)
			continue
		}
		headers.set(name, value)
	}
	return headers
}

function declaredContentLength(request: IncomingMessage): number | null {
	const header = request.headers['content-length']
	if (header === undefined) return null
	const contentLength = Number(header)
	if (!Number.isInteger(contentLength) || contentLength < 0) return null
	return contentLength
}

export async function startLocalNxCacheServer(options?: {
	token?: string
	store?: NxCacheStore
}): Promise<LocalNxCacheServer> {
	const token = options?.token ?? 'nx-cache-smoke-token'
	const store = options?.store ?? createMemoryCacheStore()
	const requests: Array<NxCacheRequestLog> = []

	const server: Server = createServer((incoming, outgoing) => {
		void handleIncoming(incoming, outgoing)
	})

	async function handleIncoming(
		incoming: IncomingMessage,
		outgoing: ServerResponse,
	) {
		const host = incoming.headers.host ?? '127.0.0.1'
		const url = new URL(incoming.url ?? '/', `http://${host}`)
		const method = incoming.method ?? 'GET'
		try {
			const hasBody = method !== 'GET' && method !== 'HEAD'
			const contentLength = declaredContentLength(incoming)
			if (
				hasBody &&
				contentLength !== null &&
				contentLength > MAX_ARTIFACT_BYTES
			) {
				requests.push({ method, pathname: url.pathname, status: 413 })
				outgoing.statusCode = 413
				outgoing.end()
				incoming.resume()
				return
			}
			const body = hasBody
				? await collectBody(incoming, MAX_ARTIFACT_BYTES)
				: null
			const requestBody =
				body && body.byteLength > 0
					? body.buffer.slice(
							body.byteOffset,
							body.byteOffset + body.byteLength,
						)
					: undefined
			const request = new Request(url, {
				method,
				headers: headersFromIncoming(incoming),
				body: requestBody instanceof ArrayBuffer ? requestBody : undefined,
			})
			const response = await handleNxCacheRequest(
				request,
				{ CACHE_ACCESS_TOKEN: token, BUILD_COMMIT: 'smoke' },
				store,
			)
			requests.push({
				method,
				pathname: url.pathname,
				status: response.status,
			})
			outgoing.statusCode = response.status
			response.headers.forEach((value, name) => {
				outgoing.setHeader(name, value)
			})
			outgoing.end(Buffer.from(await response.arrayBuffer()))
		} catch (error) {
			const status = error instanceof PayloadTooLargeError ? 413 : 500
			requests.push({ method, pathname: url.pathname, status })
			if (!outgoing.headersSent) {
				outgoing.statusCode = status
				outgoing.end()
			}
		}
	}

	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve)
	})
	const address = server.address()
	if (!address || typeof address === 'string') {
		throw new Error('Failed to bind the local Nx cache server')
	}

	return {
		url: `http://127.0.0.1:${address.port}`,
		token,
		store,
		requests,
		close() {
			return new Promise((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error)
					else resolve()
				})
			})
		},
	}
}
