import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	assertAppVisitConsent,
	resolveAppVisitTarget,
} from '#mcp/capabilities/packages/app-visit-target.ts'
import { servePackageAppRequest } from '#worker/package-runtime/package-app-serve.ts'
import {
	appFetchCapabilityName,
	packageAppSyntheticHeaderName,
} from '#worker/package-runtime/package-app-synthetic.ts'

/** Body cap for a request, and for a response unless the caller raises it. */
export const appFetchDefaultMaxBodyBytes = 102_400
/** The most a response body may ever return, whatever the caller asks for. */
export const appFetchHardMaxBodyBytes = 10 * 1024 * 1024

const runtimeCallerErrorMessage =
	'appFetch runs for a person or their agent. Call it from an interactive MCP session, execute, the Open API, or the kody CLI. Package app and job code cannot call it.'

/**
 * MCP OAuth credentials use the default cap; other credentials can raise it
 * up to the hard cap.
 */
function responseBodyCap(
	request: RequestContext,
	requested: number | undefined,
) {
	if (request.credential.kind === 'mcp-oauth')
		return appFetchDefaultMaxBodyBytes
	return Math.min(
		requested ?? appFetchDefaultMaxBodyBytes,
		appFetchHardMaxBodyBytes,
	)
}

const blockedRequestHeaderNames = new Set([
	'cookie',
	'authorization',
	'connection',
	'content-length',
	'host',
	'proxy-authorization',
	'transfer-encoding',
	'upgrade',
	'forwarded',
	packageAppSyntheticHeaderName.toLowerCase(),
])

const blockedResponseHeaderNames = new Set([
	'set-cookie',
	'authorization',
	'connection',
	'content-encoding',
	'content-length',
	'proxy-authorization',
	'transfer-encoding',
])

const allowedMethods = new Set([
	'GET',
	'HEAD',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'OPTIONS',
])

function collectSafeRequestHeaders(
	headers: Record<string, string> | undefined,
) {
	const collected = new Headers()
	if (!headers) return collected
	for (const [name, value] of Object.entries(headers)) {
		const normalized = name.trim().toLowerCase()
		if (!normalized || blockedRequestHeaderNames.has(normalized)) {
			continue
		}
		if (
			normalized.startsWith('x-kody-') ||
			normalized.startsWith('x-forwarded-') ||
			normalized.startsWith('cf-')
		) {
			continue
		}
		collected.set(name, value)
	}
	return collected
}

function collectSafeResponseHeaders(response: Response) {
	const headers: Record<string, string> = {}
	response.headers.forEach((value, name) => {
		const normalized = name.toLowerCase()
		if (blockedResponseHeaderNames.has(normalized)) {
			return
		}
		if (normalized.startsWith('x-kody-')) {
			return
		}
		headers[normalized] = value
	})
	return headers
}

function decodeUtf8Body(bytes: Uint8Array) {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
			bytes,
		)
	} catch {
		return null
	}
}

function isTextualResponse(response: Response) {
	const contentType = response.headers
		.get('Content-Type')
		?.split(';', 1)[0]
		?.trim()
		.toLowerCase()
	if (!contentType) return null
	return (
		contentType.startsWith('text/') ||
		contentType.endsWith('+json') ||
		contentType.endsWith('+xml') ||
		[
			'application/json',
			'application/xml',
			'application/javascript',
			'application/x-www-form-urlencoded',
			'application/graphql',
			'application/sql',
		].includes(contentType)
	)
}

function encodeAppFetchBody(response: Response, bytes: Uint8Array) {
	const text = decodeUtf8Body(bytes)
	if (
		isTextualResponse(response) === true ||
		(!response.headers.has('Content-Type') && text !== null)
	) {
		if (text === null) {
			return { body: bytesToBase64(bytes), encoding: 'base64' as const }
		}
		return { body: text, encoding: 'text' as const }
	}
	return { body: bytesToBase64(bytes), encoding: 'base64' as const }
}

async function readResponseBodyWithTruncation(
	response: Response,
	maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (response.body == null) {
		const text = await response.text()
		const bytes = new TextEncoder().encode(text)
		if (bytes.byteLength <= maxBytes) {
			return { bytes, truncated: false }
		}
		return { bytes: bytes.slice(0, maxBytes), truncated: true }
	}

	const reader = response.body.getReader()
	const chunks: Array<Uint8Array> = []
	let totalBytes = 0
	let truncated = false
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}
			if (!value || value.byteLength === 0) {
				continue
			}
			if (totalBytes + value.byteLength > maxBytes) {
				const remaining = maxBytes - totalBytes
				if (remaining > 0) {
					chunks.push(value.slice(0, remaining))
					totalBytes += remaining
				}
				truncated = true
				void reader.cancel().catch(() => {})
				break
			}
			totalBytes += value.byteLength
			chunks.push(value)
		}
	} catch (error) {
		void reader.cancel().catch(() => {})
		throw error
	}

	const merged = new Uint8Array(totalBytes)
	let offset = 0
	for (const chunk of chunks) {
		merged.set(chunk, offset)
		offset += chunk.byteLength
	}
	return { bytes: merged, truncated }
}

function assertRequestBodyWithinLimit(body: string | undefined) {
	if (body == null) return
	const byteLength = new TextEncoder().encode(body).byteLength
	if (byteLength > appFetchDefaultMaxBodyBytes) {
		throw new McpCallerError(
			`appFetch request body exceeds ${appFetchDefaultMaxBodyBytes} bytes. Send a smaller body.`,
		)
	}
}

export const appFetchCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: appFetchCapabilityName,
		contextRuns: 'allow',
		orgPermission: 'none',
		description:
			'Send one HTTP request to a hosted package app as the signed-in person, e.g. appFetch({ app: "@acme/board", path: "/api/cards" }). Use appList to find an address, including apps shared from another org. Calls can have real side effects, even with synthetic: true. See /docs/agent-apps for access and consent.',
		keywords: [
			'app',
			'package app',
			'app fetch',
			'call app',
			'use app',
			'visit',
			'shared app',
			'synthetic',
			'smoke test',
			'hosted app',
			'kody.run',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z
			.object({
				app: z
					.string()
					.min(1)
					.optional()
					.describe(
						'The app: @org/app (the owning org handle and the app name) or its hosted URL. A path in the address is used when path is omitted.',
					),
				package_id: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Saved package id of the app, as appList and packageList return it. Use instead of app.',
					),
				path: z
					.string()
					.optional()
					.describe(
						'Path after the app mount that the handler sees, with any query string. Defaults to /.',
					),
				method: z
					.string()
					.optional()
					.describe(
						'HTTP method, case-insensitive: GET, HEAD, POST, PUT, PATCH, DELETE, or OPTIONS. Defaults to GET.',
					),
				headers: z
					.record(z.string(), z.string())
					.optional()
					.describe(
						'Extra request headers. Credential, internal, upgrade, and Kody-Synthetic headers are stripped.',
					),
				body: z
					.string()
					.max(appFetchDefaultMaxBodyBytes)
					.optional()
					.describe(
						'Raw request body string for POST, PUT, or PATCH. At most 102,400 UTF-8 bytes; the schema bounds characters and the bytes are checked when the request is sent.',
					),
				synthetic: z
					.boolean()
					.optional()
					.describe(
						'True marks the request as a smoke test with the Kody-Synthetic: true header. Omit it for a real visit. The handler still runs with real side effects either way.',
					),
				max_bytes: z
					.number()
					.int()
					.min(1)
					.max(appFetchHardMaxBodyBytes)
					.optional()
					.describe(
						'Most response body bytes to return before truncating. Defaults to 102,400. The Open API and the CLI (kody app fetch --out) may raise it to 10,485,760; MCP OAuth calls stay at 102,400.',
					),
			})
			.superRefine((value, ctx) => {
				if ((value.app === undefined) === (value.package_id === undefined)) {
					ctx.addIssue({
						code: 'custom',
						message: 'Provide exactly one of `app` or `package_id`.',
					})
				}
			}),
		outputSchema: z.object({
			status: z.number().int(),
			headers: z.record(z.string(), z.string()),
			body: z.string(),
			body_encoding: z
				.enum(['text', 'base64'])
				.describe('base64 when the response body is not text.'),
			truncated: z.boolean(),
		}),
		async handler(args, ctx) {
			const method = (args.method?.trim().toUpperCase() || 'GET') as string
			if (!allowedMethods.has(method)) {
				throw new McpCallerError(
					`appFetch does not support HTTP method "${method}". Use GET, HEAD, POST, PUT, PATCH, DELETE, or OPTIONS.`,
				)
			}
			if (
				args.headers &&
				Object.entries(args.headers).some(([name, value]) => {
					const normalizedName = name.toLowerCase()
					return (
						normalizedName === 'upgrade' ||
						(normalizedName === 'connection' &&
							value
								.toLowerCase()
								.split(',')
								.some((token) => token.trim() === 'upgrade'))
					)
				})
			) {
				throw new McpCallerError(
					'appFetch does not support websocket Upgrade requests. Open the hosted URL in a browser for realtime.',
				)
			}
			assertRequestBodyWithinLimit(args.body)

			const target = await resolveAppVisitTarget(
				ctx,
				args,
				appFetchCapabilityName,
				runtimeCallerErrorMessage,
			)

			const requestHeaders = collectSafeRequestHeaders(args.headers)
			if (!requestHeaders.has('accept')) {
				requestHeaders.set('Accept', 'application/json')
			}
			const requestInit: RequestInit = {
				method,
				headers: requestHeaders,
			}
			if (args.body != null && method !== 'GET' && method !== 'HEAD') {
				requestInit.body = args.body
			}
			const request = new Request(target.url, requestInit)

			const response = await servePackageAppRequest({
				request,
				env: ctx.env,
				owner: target.owner,
				visitor: target.visitor,
				packagePath: target.packagePath,
				dispatch: { agent: true, synthetic: args.synthetic === true },
			})
			await assertAppVisitConsent(target, response, request.url)

			const maxBytes = responseBodyCap(target.callerRequest, args.max_bytes)
			const { bytes, truncated } = await readResponseBodyWithTruncation(
				response,
				maxBytes,
			)
			const encoded = encodeAppFetchBody(response, bytes)
			const maxBase64SourceBytes = Math.floor(maxBytes / 4) * 3
			// Base64 only has to fit the cap where the body lands in an agent's
			// context. A larger requested cap counts the bytes written to disk.
			const encodedBodyTooLarge =
				maxBytes <= appFetchDefaultMaxBodyBytes &&
				encoded.encoding === 'base64' &&
				bytes.byteLength > maxBase64SourceBytes
			const body = encodedBodyTooLarge
				? bytesToBase64(bytes.slice(0, maxBase64SourceBytes))
				: encoded.body
			return {
				status: response.status,
				headers: collectSafeResponseHeaders(response),
				body,
				body_encoding: encoded.encoding,
				truncated: truncated || encodedBodyTooLarge,
			}
		},
	},
)
