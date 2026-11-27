import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { resolveHostedPackageAppLocation } from '@kody-internal/shared/public-urls.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { z } from 'zod'
import {
	resolveAppAddress,
	type AppAddress,
} from '#worker/app-visit/address.ts'
import { AppConsentRequiredError } from '#worker/app-visit/consent-required.ts'
import { authorizeAppVisit } from '#worker/app-visit/authorize.ts'
import {
	packageAppRunConsentRequiredHeader,
	packageAppRunConsentUrl,
} from '#worker/app-visit/run-consent-url.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { requireInteractiveMcpCaller } from '#mcp/capabilities/meta/require-interactive-caller.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { getOrgById } from '#worker/orgs/repo.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'
import {
	servePackageAppRequest,
	type PackageAppPath,
} from '#worker/package-runtime/package-app-serve.ts'
import {
	appFetchCapabilityName,
	packageAppSyntheticHeaderName,
	packageAppVisitorConsentRequiredHeader,
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

function appNotFound(label: string) {
	return new McpCallerError(
		`No app ${label} that you can run. Check the address with appList, which lists every app you can run, or ask the app's owner to share it with you (Use on the app).`,
	)
}

async function resolveRequestedApp(
	ctx: { env: Env; callerContext: { baseUrl: string } },
	args: { app?: string; package_id?: string },
): Promise<AppAddress & { label: string }> {
	if (args.app !== undefined) {
		const address = await resolveAppAddress({
			env: ctx.env,
			address: args.app,
			appBaseUrl: ctx.callerContext.baseUrl,
		})
		return { ...address, label: `at "${args.app}"` }
	}
	const label = `with package_id "${args.package_id}"`
	const saved = await getSavedPackageByIdInAnyOrg(
		ctx.env.APP_DB,
		args.package_id ?? '',
	)
	const org = saved ? await getOrgById(ctx.env.APP_DB, saved.userId) : null
	if (!saved || !org) throw appNotFound(label)
	return {
		ownerHandle: org.slug,
		appSlug: getPackageNameLeaf(saved.name),
		path: null,
		label,
	}
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

function normalizeAppFetchPath(path: string | undefined) {
	const trimmed = path?.trim() ?? ''
	if (!trimmed || trimmed === '/') return '/'
	const pathOnly = trimmed.split(/[?#]/, 1)[0] ?? ''
	for (const segment of pathOnly.split(/[\\/]/)) {
		let decoded: string
		try {
			decoded = decodeURIComponent(segment)
		} catch {
			throw new McpCallerError(
				'appFetch path contains invalid percent encoding.',
			)
		}
		if (decoded === '..') {
			throw new McpCallerError(
				'appFetch path must not contain parent traversal segments.',
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
			const user = requireMcpUser(ctx.callerContext)
			requireInteractiveMcpCaller(ctx.callerContext, runtimeCallerErrorMessage)

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

			const callerRequest = requireMcpRequest(ctx.callerContext)
			if (!callerRequest.actor) {
				throw new McpCallerError(
					`${appFetchCapabilityName} needs a signed-in caller, who the app acts as.`,
				)
			}
			const requested = await resolveRequestedApp(ctx, args)
			// Validate the path before the access check so traversal and encoding
			// errors fail closed without warming any cache.
			const restPath = normalizeAppFetchPath(args.path ?? requested.path ?? '/')
			const restPathOnly = restPath.split(/[?#]/, 1)[0] || '/'

			// The one visit check, in the org that owns the app, with this
			// request's profile chain and token scopes (ADR 0062).
			const visit = await authorizeAppVisit({
				env: ctx.env,
				callerRequest,
				ownerHandle: requested.ownerHandle,
				appSlug: requested.appSlug,
			})
			if (visit.kind === 'not-found') throw appNotFound(requested.label)
			if (visit.kind === 'forbidden') {
				// The person can run it but this credential cannot: say which
				// layer to fix. Anything else reads the same as a missing app.
				const code = visit.error?.code
				if (
					visit.error &&
					(code === 'profile_grant' ||
						code === 'profile_inactive' ||
						code === 'credential_scope')
				) {
					throw visit.error
				}
				throw appNotFound(requested.label)
			}
			const app = visit.app
			if (!app?.hasApp) throw appNotFound(requested.label)
			const appSlug = visit.retiredSlug
				? getPackageNameLeaf(app.name)
				: requested.appSlug
			const { owner } = visit

			// A custom domain the caller named stays the app's host, so links
			// the app builds from the request point back at that domain.
			const customMount = visit.retiredSlug ? null : requested.customMount
			const packageAppOrigin = getPackageAppBaseUrl({ env: ctx.env })
			const hosted = resolveHostedPackageAppLocation({
				packageAppBaseUrl: packageAppOrigin,
				appBaseUrl: ctx.callerContext.baseUrl,
				username: owner.username,
				kodyId: appSlug,
				restPath: restPath === '/' ? null : restPath,
			})
			const packagePath: PackageAppPath = {
				username: owner.username,
				kodyId: appSlug,
				restPath: restPathOnly,
				mount: customMount
					? customMount.mount
					: !packageAppOrigin
						? 'username-path'
						: hosted.appBasePath === ''
							? 'custom-hostname'
							: 'user-subdomain',
			}
			const appLabel = `@${owner.username}/${appSlug}`
			const runConsentRequired = () =>
				new AppConsentRequiredError({
					consent: 'run_as_me',
					app: appLabel,
					consentUrl: packageAppRunConsentUrl({
						baseUrl: ctx.callerContext.baseUrl,
						packagePath: { ...packagePath, restPath: '/' },
					}).toString(),
				})
			if (visit.needsRunConsent) throw runConsentRequired()

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
			const request = new Request(
				customMount
					? `${customMount.baseUrl}${restPath === '/' && customMount.mount !== 'custom-hostname' ? '' : restPath}`
					: hosted.hostedUrl,
				requestInit,
			)

			const response = await servePackageAppRequest({
				request,
				env: ctx.env,
				owner: {
					userId: owner.userId,
					username: owner.username,
					// Team org entitlements resolve by org id alone.
					email:
						owner.userId === personalOrgIdForPerson(user) ? user.email : '',
					displayName: owner.displayName,
				},
				visitor: {
					...visit.visitor,
					username: visit.visitor.username || user.username || '',
				},
				packagePath,
				dispatch: { agent: true, synthetic: args.synthetic === true },
			})
			if (
				response.headers.get(packageAppRunConsentRequiredHeader) === 'required'
			) {
				throw runConsentRequired()
			}
			if (
				response.headers.get(packageAppVisitorConsentRequiredHeader) ===
				'required'
			) {
				const refusal = (await response.json().catch(() => null)) as {
					need?: unknown
					consent_url?: unknown
				} | null
				// App code can set this header too, so only a link to Kody's own
				// sign-in page for this app's host is passed on to the person.
				const consentUrl =
					typeof refusal?.consent_url === 'string'
						? URL.parse(refusal.consent_url)
						: null
				const expected = new URL(packageAppOauthPaths.login, request.url)
				if (
					!consentUrl ||
					consentUrl.origin !== expected.origin ||
					consentUrl.pathname !== expected.pathname
				) {
					throw new Error('App consent refusal carried no valid consent link.')
				}
				throw new AppConsentRequiredError({
					consent: 'visitor_need',
					app: appLabel,
					consentUrl: consentUrl.toString(),
					need: typeof refusal?.need === 'string' ? refusal?.need : null,
				})
			}

			const maxBytes = responseBodyCap(callerRequest, args.max_bytes)
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
