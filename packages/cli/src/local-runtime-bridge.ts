/**
 * Loopback HTTP bridge between local workerd and the CLI host process.
 *
 * - `POST /call` — JSON CapabilityProxy hop (`{ path, args }` → `{ result|error }`)
 * - `POST /gateway-fetch` — streaming gateway-fetch hop (raw body in/out)
 */

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import {
	CapabilityProxyError,
	gatewayFetchErrorHeaderName,
} from './capability-proxy.js'
import { redact } from './redact.js'
import { runSecretHeader } from './local-runtime-source.js'
import { localBridgeTlsCheckPath } from './local-egress.js'
import {
	certErrorCode,
	certErrorMessage,
	checkTlsCertificate,
	isCertErrorCode,
} from './tls-errors.js'

const localBridgeCallPath = '/call'
export const localBridgeGatewayFetchPath = '/gateway-fetch'
const localBridgeHostFsPath = '/fs'

export type LocalRuntimeBridge = {
	port: number
	close: () => Promise<void>
}

type LocalRuntimeBridgeCall = {
	path: Array<string>
	args: Array<unknown>
}

export type LocalRuntimeBridgeInput = {
	runSecret: string
	forwardCall: (
		call: LocalRuntimeBridgeCall,
		signal: AbortSignal,
	) => Promise<unknown>
	/**
	 * Streaming gateway-fetch. Must write a complete HTTP response to
	 * `response` (status, headers, body) — including Open API error envelopes.
	 */
	forwardGatewayFetchStream: (input: {
		request: IncomingMessage
		response: ServerResponse
		signal: AbortSignal
	}) => Promise<void>
	/** Host-folder fs calls for an execution-context run with mounts. */
	forwardHostFs?: (body: unknown) => Promise<unknown>
}

/** False only when the hop failed before any request byte left the CLI. */
function gatewayHopMayHaveReachedOrigin(error: unknown): boolean {
	return !(error instanceof CapabilityProxyError && error.sent === false)
}

export async function startLocalRuntimeBridge(
	input: LocalRuntimeBridgeInput,
): Promise<LocalRuntimeBridge> {
	const inFlight = new AbortController()
	const server: Server = createServer(async (request, response) => {
		const replyJson = (
			status: number,
			body: unknown,
			headers: Record<string, string> = {},
		) => {
			response.writeHead(status, {
				'content-type': 'application/json',
				...headers,
			})
			response.end(JSON.stringify(body))
		}
		/** Marked Open API-shaped error so workerd `gatewayFetchStream` throws. */
		const replyGatewayFetchError = (
			status: number,
			message: string,
			code: string,
			mayHaveReachedOrigin: boolean,
		) => {
			replyJson(
				status,
				{ error: { code, message, mayHaveReachedOrigin } },
				{ 'Cache-Control': 'no-store', [gatewayFetchErrorHeaderName]: code },
			)
		}
		if (request.headers[runSecretHeader] !== input.runSecret) {
			replyJson(403, {
				error:
					'Forbidden: missing run secret. Only the workerd started by this kody process may call its bridge.',
			})
			return
		}
		if (request.method === 'POST' && request.url === localBridgeCallPath) {
			try {
				const call = parseBridgeCall(await readBodyText(request))
				const result = await input.forwardCall(call, inFlight.signal)
				replyJson(200, { result })
			} catch (error) {
				replyJson(200, {
					error: redact(error instanceof Error ? error.message : String(error)),
				})
			}
			return
		}
		if (
			request.method === 'POST' &&
			request.url === localBridgeGatewayFetchPath
		) {
			// One hop's signal: the run ending or workerd dropping this request
			// (caller AbortSignal, mid-body disconnect) stops the upstream hop.
			const hop = new AbortController()
			const abortHop = () =>
				hop.abort(new Error('The local gateway fetch was cancelled.'))
			if (inFlight.signal.aborted) abortHop()
			else inFlight.signal.addEventListener('abort', abortHop, { once: true })
			response.once('close', () => {
				inFlight.signal.removeEventListener('abort', abortHop)
				if (!response.writableFinished) abortHop()
			})
			try {
				await input.forwardGatewayFetchStream({
					request,
					response,
					signal: hop.signal,
				})
			} catch (error) {
				if (response.headersSent) {
					response.destroy(
						error instanceof Error ? error : new Error(String(error)),
					)
					return
				}
				const certCode = certErrorCode(error)
				replyGatewayFetchError(
					502,
					certCode
						? certErrorMessage(certCode, 'the Kody API')
						: redact(error instanceof Error ? error.message : String(error)),
					certCode ? 'tls_certificate_error' : 'gateway_fetch_failed',
					!certCode && gatewayHopMayHaveReachedOrigin(error),
				)
			}
			return
		}
		if (request.method === 'POST' && request.url === localBridgeTlsCheckPath) {
			try {
				const body = JSON.parse(await readBodyText(request)) as {
					host?: unknown
					port?: unknown
				}
				const host = typeof body.host === 'string' ? body.host : ''
				const port = Number(body.port)
				if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
					replyJson(400, { message: null })
					return
				}
				const code = await checkTlsCertificate({ host, port })
				replyJson(200, {
					message: isCertErrorCode(code) ? certErrorMessage(code, host) : null,
				})
			} catch {
				replyJson(200, { message: null })
			}
			return
		}
		if (
			request.method === 'POST' &&
			request.url === localBridgeHostFsPath &&
			input.forwardHostFs
		) {
			try {
				const body: unknown = JSON.parse(await readBodyText(request))
				replyJson(200, { result: await input.forwardHostFs(body) })
			} catch (error) {
				const code = (error as { code?: unknown })?.code
				replyJson(200, {
					error: {
						code: typeof code === 'string' ? code : 'EIO',
						message: error instanceof Error ? error.message : String(error),
					},
				})
			}
			return
		}
		replyJson(404, {
			error:
				'Not found: the kody bridge only accepts POST /call and POST /gateway-fetch.',
		})
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => resolve())
	})
	return {
		port: (server.address() as AddressInfo).port,
		close: () =>
			new Promise<void>((resolve) => {
				inFlight.abort()
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	}
}

function parseBridgeCall(body: string): LocalRuntimeBridgeCall {
	const parsed = JSON.parse(body) as { path?: unknown; args?: unknown }
	if (
		!Array.isArray(parsed.path) ||
		parsed.path.length === 0 ||
		!parsed.path.every((segment) => typeof segment === 'string')
	) {
		throw new Error('Invalid kody:runtime call path.')
	}
	return {
		path: parsed.path as Array<string>,
		args: Array.isArray(parsed.args) ? parsed.args : [],
	}
}

async function readBodyText(stream: IncomingMessage): Promise<string> {
	const chunks: Array<Buffer> = []
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf8')
}

export async function readBodyBuffer(stream: IncomingMessage): Promise<Buffer> {
	const chunks: Array<Buffer> = []
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks)
}

/** Write a Web `Response` onto a Node `ServerResponse` (streams the body). */
export async function writeWebResponse(
	response: ServerResponse,
	web: Response,
): Promise<void> {
	const headers: Record<string, string | Array<string>> = {}
	web.headers.forEach((value, name) => {
		const existing = headers[name]
		if (existing === undefined) {
			headers[name] = value
			return
		}
		headers[name] = Array.isArray(existing)
			? [...existing, value]
			: [existing, value]
	})
	response.writeHead(web.status, web.statusText, headers)
	if (!web.body) {
		response.end()
		return
	}
	const nodeStream = Readable.fromWeb(
		web.body as import('node:stream/web').ReadableStream,
	)
	await new Promise<void>((resolve, reject) => {
		nodeStream.on('error', reject)
		response.on('error', reject)
		response.on('finish', () => resolve())
		// A reader that goes away before the end cancels the upstream body
		// instead of leaving it open.
		response.on('close', () => {
			if (response.writableFinished) return
			nodeStream.destroy()
			resolve()
		})
		nodeStream.pipe(response)
	})
}
