import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { resolveHostedPackageAppUrl } from '@kody-internal/shared/public-urls.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { requireInteractiveMcpCaller } from '#mcp/capabilities/meta/require-interactive-caller.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { resolveDisplayName } from '#worker/identity/username.ts'
import { resolveSavedPackageWithFreshnessCache } from '#worker/package-invocations/invoke-contract-cache.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import {
	buildPlainRepoPromotionErrorMessage,
	findPlainRepoPromotionHint,
} from '#worker/repo/user-repos.ts'
import {
	servePackageAppRequest,
	type PackageAppPath,
} from '#worker/package-runtime/package-app-serve.ts'
import {
	packageAppFetchCapabilityName,
	packageAppSyntheticHeaderName,
} from '#worker/package-runtime/package-app-synthetic.ts'
import {
	findOwnedSavedPackage,
	normalizeRequestedKodyId,
	packageIdentityCountMessage,
	packageIdentityInputShape,
} from './owned-package-lookup.ts'

export const packageAppFetchMaxBodyBytes = 102_400

const packageRuntimeCallerErrorMessage =
	'packageAppFetch is unavailable from package runtime contexts. Call it from an interactive MCP agent instead.'

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

function normalizePackageAppFetchPath(path: string | undefined) {
	const trimmed = path?.trim() ?? ''
	if (!trimmed || trimmed === '/') return '/'
	const pathOnly = trimmed.split(/[?#]/, 1)[0] ?? ''
	for (const segment of pathOnly.split(/[\\/]/)) {
		let decoded: string
		try {
			decoded = decodeURIComponent(segment)
		} catch {
			throw new McpCallerError(
				'packageAppFetch path contains invalid percent encoding.',
			)
		}
		if (decoded === '..') {
			throw new McpCallerError(
				'packageAppFetch path must not contain parent traversal segments.',
			)
		}
	}
	return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

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
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
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

function encodePackageAppFetchBody(response: Response, bytes: Uint8Array) {
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
	if (byteLength > packageAppFetchMaxBodyBytes) {
		throw new McpCallerError(
			`packageAppFetch request body exceeds ${packageAppFetchMaxBodyBytes} bytes.`,
		)
	}
}

export const packageAppFetchCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: packageAppFetchCapabilityName,
		contextRuns: 'allow',
		orgPermission: 'app:execute',
		description:
			'Invoke a published package app fetch handler with a synthetic HTTP request for post-publish smoke tests. Runs on the app_fetch surface with normal package context, packageStorage(), and secret mounts; handler side effects are real. Does not replace hosted-URL checks for browser UI, cookies, OAuth redirects, or websocket realtime flows.',
		keywords: [
			'package app',
			'app fetch',
			'synthetic',
			'test',
			'smoke test',
			'simulate',
			'probe',
			'hosted app',
			'kody.app',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z
			.object({
				...packageIdentityInputShape,
				path: z
					.string()
					.optional()
					.describe(
						'Path after the app mount that the handler sees. Defaults to /.',
					),
				method: z.string().optional().describe('HTTP method. Defaults to GET.'),
				headers: z
					.record(z.string(), z.string())
					.optional()
					.describe(
						'Extra request headers. Credential, internal, upgrade, and Kody-Synthetic headers are stripped.',
					),
				body: z
					.string()
					.optional()
					.describe(
						'Raw request body string for POST, PUT, or PATCH. Capped at about 100 KB.',
					),
			})
			.superRefine((value, ctx) => {
				const identityCount =
					(value.package_id !== undefined ? 1 : 0) +
					(value.kody_id !== undefined ? 1 : 0)
				if (identityCount !== 1) {
					ctx.addIssue({
						code: 'custom',
						message: packageIdentityCountMessage,
					})
				}
			}),
		outputSchema: z.object({
			status: z.number().int(),
			headers: z.record(z.string(), z.string()),
			body: z.string(),
			truncated: z.boolean(),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			requireInteractiveMcpCaller(
				ctx.callerContext,
				packageRuntimeCallerErrorMessage,
			)

			const method = (args.method?.trim().toUpperCase() || 'GET') as string
			if (!allowedMethods.has(method)) {
				throw new McpCallerError(
					`packageAppFetch does not support HTTP method "${method}".`,
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
					'packageAppFetch does not support websocket Upgrade requests.',
				)
			}
			assertRequestBodyWithinLimit(args.body)

			// Validate the path before any D1 lookup so traversal and encoding
			// errors fail closed without warming the saved-package cache.
			const restPath = normalizePackageAppFetchPath(args.path)
			const restPathOnly = restPath.split(/[?#]/, 1)[0] || '/'

			const callerRequest = requireMcpRequest(ctx.callerContext)
			if (!callerRequest.actor) {
				throw new McpCallerError(
					`${packageAppFetchCapabilityName} needs a signed-in caller, who the app acts as.`,
				)
			}
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: callerRequest,
			})
			const requestedKodyId = normalizeRequestedKodyId({
				kodyId: args.kody_id,
				ownerScope: owner.ownerScope,
			})
			const packageIdOrKodyId = args.package_id ?? requestedKodyId ?? ''
			const lookupId = args.package_id ?? args.kody_id ?? ''
			const savedPackage = await resolveSavedPackageWithFreshnessCache({
				userId: owner.ownerUserId,
				packageIdOrKodyId,
				load: async () =>
					(
						await findOwnedSavedPackage({
							db: ctx.env.APP_DB,
							userId: owner.ownerUserId,
							ownerScope: owner.ownerScope,
							args,
						})
					).savedPackage,
			})
			if (!savedPackage) {
				const plainRepo = await findPlainRepoPromotionHint(ctx.env.APP_DB, {
					userId: owner.ownerUserId,
					packageIdOrKodyId: lookupId,
				})
				if (plainRepo) {
					throw new McpCallerError(
						buildPlainRepoPromotionErrorMessage(lookupId),
					)
				}
				throw new McpCallerError('Saved package not found for this user.')
			}
			if (!savedPackage.hasApp) {
				throw new McpCallerError(
					`Saved package "${savedPackage.kodyId}" has no declared app (package.json#kody.app). Use a static kody:@ import from execute for export smoke tests, or ${packageAppFetchCapabilityName} after declaring kody.app.`,
				)
			}

			const packageAppOrigin = getPackageAppBaseUrl({ env: ctx.env })
			const hostedUrl = resolveHostedPackageAppUrl({
				packageAppBaseUrl: packageAppOrigin,
				appBaseUrl: ctx.callerContext.baseUrl,
				username: owner.ownerScope,
				kodyId: savedPackage.kodyId,
				restPath: restPath === '/' ? null : restPath,
			})
			const packagePath: PackageAppPath = {
				username: owner.ownerScope,
				kodyId: savedPackage.kodyId,
				restPath: restPathOnly,
				mount: packageAppOrigin ? 'user-subdomain' : 'username-path',
			}

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
			const request = new Request(hostedUrl, requestInit)

			const response = await servePackageAppRequest({
				request,
				env: ctx.env,
				owner: {
					userId: owner.ownerUserId,
					username: owner.ownerScope,
					email: owner.ownerEmail,
					displayName: resolveDisplayName({
						email: owner.ownerEmail,
						username: owner.ownerScope,
					}),
				},
				visitor: {
					userId: callerRequest.actor.userId,
					username: callerRequest.actor.username ?? user.username ?? '',
					role: callerRequest.membership?.role ?? null,
				},
				packagePath,
				dispatch: { synthetic: true },
			})

			const { bytes, truncated } = await readResponseBodyWithTruncation(
				response,
				packageAppFetchMaxBodyBytes,
			)
			const encoded = encodePackageAppFetchBody(response, bytes)
			const maxBase64SourceBytes =
				Math.floor(packageAppFetchMaxBodyBytes / 4) * 3
			const encodedBodyTooLarge =
				encoded.encoding === 'base64' && bytes.byteLength > maxBase64SourceBytes
			const body = encodedBodyTooLarge
				? bytesToBase64(bytes.slice(0, maxBase64SourceBytes))
				: encoded.body
			return {
				status: response.status,
				headers: collectSafeResponseHeaders(response),
				body,
				truncated: truncated || encodedBodyTooLarge,
			}
		},
	},
)
