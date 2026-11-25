/**
 * Git smart HTTP for Artifacts ref discovery.
 *
 * isomorphic-git's web client calls `fetch` with no deadline (`signal` is
 * reserved and ignored). A stalled `info/refs` response then holds
 * `packageGetGitRemote` until the MCP client times out. This client aborts
 * the request so the retry loop can fail with an explicit error instead.
 */

import {
	gitRemoteReadOnlyPushRejectedMessage,
	isGitReceivePackUrl,
	mapGitRemotePushAuthFailure,
} from './git-remote-scope.ts'

export const artifactsGitRequestTimeoutMs = 8_000

export class ArtifactsGitTimeoutError extends Error {
	constructor(timeoutMs: number, options?: { cause?: unknown }) {
		super(`Artifacts git request timed out after ${timeoutMs}ms.`, options)
		this.name = 'ArtifactsGitTimeoutError'
	}
}

type ArtifactsGitHttpRequest = {
	url: string
	method?: string
	headers?: Record<string, string>
	body?: AsyncIterable<Uint8Array>
}

async function collectAsyncBytes(iterable: AsyncIterable<Uint8Array>) {
	const chunks: Array<Uint8Array> = []
	let size = 0
	for await (const chunk of iterable) {
		chunks.push(chunk)
		size += chunk.byteLength
	}
	const result = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		result.set(chunk, offset)
		offset += chunk.byteLength
	}
	return result
}

async function* singleChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
	yield bytes
}

function isFetchDeadline(error: unknown) {
	// `AbortSignal.timeout` rejects with TimeoutError. Some runtimes surface
	// the same deadline as AbortError. This client only installs that signal,
	// so either name is the deadline.
	return (
		error instanceof Error &&
		(error.name === 'TimeoutError' || error.name === 'AbortError')
	)
}

export function createArtifactsGitHttp(input?: { timeoutMs?: number }) {
	const timeoutMs = input?.timeoutMs ?? artifactsGitRequestTimeoutMs
	return {
		async request(request: ArtifactsGitHttpRequest) {
			const body = request.body
				? await collectAsyncBytes(request.body)
				: undefined
			try {
				const response = await fetch(request.url, {
					method: request.method ?? 'GET',
					headers: request.headers,
					signal: AbortSignal.timeout(timeoutMs),
					...(body ? { body } : {}),
				})
				const requestUrl = request.url
				const responseUrl = response.url || requestUrl
				const pushAuthFailure = mapGitRemotePushAuthFailure({
					url: isGitReceivePackUrl(responseUrl) ? responseUrl : requestUrl,
					statusCode: response.status,
				})
				if (pushAuthFailure) throw pushAuthFailure
				const headers: Record<string, string> = {}
				response.headers.forEach((value, key) => {
					headers[key] = value
				})
				const bytes = new Uint8Array(await response.arrayBuffer())
				return {
					url: responseUrl,
					method: request.method ?? 'GET',
					statusCode: response.status,
					statusMessage: response.statusText,
					body: singleChunk(bytes),
					headers,
				}
			} catch (error) {
				if (error instanceof ArtifactsGitTimeoutError) throw error
				if (
					error instanceof Error &&
					error.message === gitRemoteReadOnlyPushRejectedMessage
				) {
					throw error
				}
				if (isFetchDeadline(error)) {
					throw new ArtifactsGitTimeoutError(timeoutMs, { cause: error })
				}
				throw error
			}
		},
	}
}
