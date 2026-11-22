/**
 * The `login` credential kind (ADR 0068): the value holds login fields (for
 * example a username and password) as one JSON object, and the credential's
 * `config_json` holds the exchange that turns them into a session token. The
 * gateway runs the exchange and places the session on the outbound request
 * using the credential's `inject`. Reusable sessions are cached in memory
 * and encrypted in `login_credential_sessions`; single-request sessions skip
 * the cache and register logout with the caller.
 * Neither the fields, the login response, nor the session ever reach code.
 */
import { isolateCollection } from '@kody-internal/shared/isolate-state.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { z } from 'zod'
import { readBoundedBody } from '#mcp/capabilities/integrations/read-bounded-body.ts'
import { isPublicFetchHostname } from '#mcp/events/ssrf.ts'
import { encryptSecretValue, userSecretContext } from '#mcp/secrets/crypto.ts'
import { storedCredentialRevision } from '#mcp/secrets/service.ts'
import { optionalOrgAuditWriter } from '#worker/orgs/org-audit.ts'
import {
	credentialAuditActions,
	recordCredentialAudit,
} from './credential-audit.ts'
import {
	assertHttpsUrl,
	credentialHostsAllow,
	CredentialLoginFailedError,
	CredentialRequestRefusedError,
	isCredentialPlacementHeader,
} from './credential-request.ts'
import type { CredentialResolver } from './credential-resolver.ts'
import {
	type LoginSession,
	type ObtainedLoginSession,
	obtainLoginSession,
	StaleLoginCredentialError,
} from './login-session-store.ts'
import {
	authorizeStoredCredential,
	findStoredCredential,
} from './stored-credential.ts'

const maxSessionSeconds = 24 * 60 * 60
const sessionExpirySkewMs = 30_000
const exchangeTimeoutMs = 30_000
const logoutTimeoutMs = 5_000
const maxCachedSessions = 500
const maxExchangeResponseBytes = 64 * 1024
/** A failed exchange's body is read only for its OAuth `error` code. */
const maxErrorBodyBytes = 8 * 1024

export const loginExchangeSchema = z
	.object({
		url: z.string().min(1),
		method: z.enum(['POST', 'PUT']).default('POST'),
		bodyFormat: z.enum(['json', 'form']),
		/** Body fields; `{field}` in a value is replaced by that login field. */
		body: z.record(z.string(), z.string()),
		/** Dot path to the session token in the JSON response. */
		tokenPath: z.string().min(1),
		/** Dot path to the session lifetime in seconds, when the response has one. */
		expiresInPath: z.string().min(1).optional(),
		ttlSeconds: z
			.number()
			.int()
			.positive()
			.max(maxSessionSeconds)
			.default(3600),
		/**
		 * Where a provider that rotates refresh tokens puts the new one, and
		 * which login field it replaces. Kody saves it in place of the old one.
		 */
		refreshToken: z
			.object({
				path: z.string().min(1),
				field: z.string().regex(/^[A-Za-z0-9_.-]+$/),
			})
			.strict()
			.optional(),
		singleRequest: z
			.strictObject({
				logoutUrl: z.url({ protocol: /^https$/ }),
				headers: z
					.array(
						z.strictObject({
							name: z.string().max(100).refine(isCredentialPlacementHeader),
							field: z.string().regex(/^[A-Za-z0-9_.-]+$/),
						}),
					)
					.max(8)
					.default([]),
			})
			.optional(),
	})
	.strict()
	.refine(
		(exchange) =>
			!exchange.refreshToken ||
			Object.values(exchange.body).some((template) =>
				template.includes(`{${exchange.refreshToken!.field}}`),
			),
		{
			message:
				'refreshToken.field must be a login field the exchange body sends.',
			path: ['refreshToken', 'field'],
		},
	)
	.superRefine((exchange, ctx) => {
		const profile = exchange.singleRequest
		if (!profile) return
		const loginUrl = URL.parse(exchange.url)
		const logoutUrl = URL.parse(profile.logoutUrl)
		const names = profile.headers.map(({ name }) => name.toLowerCase())
		if (
			exchange.refreshToken ||
			!loginUrl ||
			loginUrl.protocol !== 'https:' ||
			loginUrl.hash ||
			!isPublicFetchHostname(loginUrl.hostname) ||
			!logoutUrl ||
			logoutUrl.origin !== loginUrl.origin ||
			logoutUrl.username ||
			logoutUrl.password ||
			logoutUrl.hash ||
			new Set(names).size !== names.length ||
			profile.headers.some(
				({ field }) =>
					!Object.values(exchange.body).some((value) =>
						value.includes(`{${field}}`),
					),
			)
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['singleRequest'],
				message:
					'Single-request Login requires a same-origin logout URL, distinct headers from existing login fields, and no refresh token rotation.',
			})
		}
	})

const sessionInjectSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('header'),
		name: z.string().min(1),
		format: z.string().includes('{value}'),
	}),
	z.object({ kind: z.literal('query'), param: z.string().min(1) }),
])

export type LoginExchange = z.infer<typeof loginExchangeSchema>

export type LoginSessionPlacement =
	| { kind: 'header'; name: string; value: string }
	| { kind: 'query'; param: string; value: string }

export type ResolvedLoginSession = {
	placement: LoginSessionPlacement
	/** Texts that carry the session, for echo redaction of the response. */
	substitutedValues: ReadonlyArray<string>
	/** Id of the stored session (never the session), for a 401 retry. */
	sessionId: string | null
	/** Additional protected headers; present only for a single-request session. */
	singleRequestHeaders?: Headers
}

type Session = LoginSession & { sessionId: string | null }

type ExchangeResult = {
	token: string
	expiresAt: number | null
	/** A rotated refresh token from the response, when the exchange names one. */
	rotatedRefreshToken: string | null
}

/**
 * Front cache of sessions by credential id and revision (a digest of the
 * stored ciphertext, exchange, hosts, and inject), so any of those edits
 * starts a new session. The durable copy is in `login_credential_sessions`;
 * `authorize` still runs on every resolution before a session is used.
 */
const sessions = isolateCollection(new Map<string, Session>())
const pendingSessions = isolateCollection(
	new PromiseLruCache<ObtainedLoginSession>({ retainSettled: false }),
)

function misconfigured(): never {
	throw new CredentialRequestRefusedError(
		'invalid_request',
		"This login credential's exchange is not set up correctly. Its owner can fix it.",
	)
}

/** Only the standard OAuth `error` code is read from a failed exchange. */
function readOAuthError(payload: unknown) {
	return payload && typeof payload === 'object' && 'error' in payload
		? payload.error
		: null
}

/** `Retry-After` as seconds (delta-seconds or an HTTP date), else null. */
export function readRetryAfterSeconds(value: string | null, now = Date.now()) {
	if (!value) return null
	const trimmed = value.trim()
	if (/^\d+$/.test(trimmed)) return Number(trimmed)
	const at = Date.parse(trimmed)
	if (Number.isNaN(at)) return null
	return Math.max(0, Math.ceil((at - now) / 1000))
}

function parseJson(text: string | null) {
	if (text == null) return null
	try {
		return JSON.parse(text) as unknown
	} catch {
		return null
	}
}

function readExchange(configJson: string | null, hosts: ReadonlyArray<string>) {
	const parsed = loginExchangeSchema.safeParse(parseJson(configJson))
	if (!parsed.success) misconfigured()
	let url: URL
	try {
		url = new URL(parsed.data.url)
	} catch {
		misconfigured()
	}
	assertHttpsUrl(url)
	if (url.username || url.password) misconfigured()
	if (!credentialHostsAllow(hosts, url.hostname)) {
		throw new CredentialRequestRefusedError(
			'host_not_allowed',
			"This login credential's exchange URL is not on one of its hosts.",
		)
	}
	return { ...parsed.data, url }
}

function readInject(injectJson: string) {
	const parsed = sessionInjectSchema.safeParse(parseJson(injectJson))
	if (!parsed.success) misconfigured()
	return parsed.data
}

function readLoginFields(value: string) {
	const parsed = parseJson(value)
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new CredentialRequestRefusedError(
			'invalid_request',
			'This login credential does not hold its fields as a JSON object. Its owner can replace the value.',
		)
	}
	const fields = new Map<string, string>()
	for (const [name, field] of Object.entries(parsed)) {
		if (typeof field === 'string') fields.set(name, field)
	}
	return { fields, object: parsed as Record<string, unknown> }
}

function renderBody(
	exchange: ReturnType<typeof readExchange>,
	fields: ReadonlyMap<string, string>,
) {
	const rendered: Record<string, string> = {}
	for (const [key, template] of Object.entries(exchange.body)) {
		rendered[key] = template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, name) => {
			const field = fields.get(name)
			if (field === undefined) {
				throw new CredentialRequestRefusedError(
					'invalid_request',
					`This login credential has no "${name}" field for its exchange. Its owner can add it.`,
				)
			}
			return field
		})
	}
	switch (exchange.bodyFormat) {
		case 'json':
			return {
				contentType: 'application/json',
				body: JSON.stringify(rendered),
			}
		case 'form':
			return {
				contentType: 'application/x-www-form-urlencoded',
				body: new URLSearchParams(rendered).toString(),
			}
		default: {
			const exhaustive: never = exchange.bodyFormat
			throw new Error(`Unhandled login body format: ${String(exhaustive)}`)
		}
	}
}

function readPath(payload: unknown, path: string) {
	let current = payload
	for (const segment of path.split('.')) {
		if (!current || typeof current !== 'object') return undefined
		current = (current as Record<string, unknown>)[segment]
	}
	return current
}

async function runExchange(
	exchange: ReturnType<typeof readExchange>,
	fields: ReadonlyMap<string, string>,
): Promise<ExchangeResult> {
	const { contentType, body } = renderBody(exchange, fields)
	let response: Response
	try {
		response = await fetch(exchange.url.href, {
			method: exchange.method,
			headers: { 'content-type': contentType, accept: 'application/json' },
			body,
			redirect: 'manual',
			signal: AbortSignal.timeout(exchangeTimeoutMs),
		})
	} catch {
		throw new CredentialLoginFailedError(null)
	}
	if (!response.ok) {
		const providerRetryAfterSeconds = readRetryAfterSeconds(
			response.headers.get('retry-after'),
		)
		const invalidGrant =
			response.status >= 400 &&
			response.status < 500 &&
			readOAuthError(
				parseJson(
					await readBoundedBody(response, maxErrorBodyBytes).catch(() => null),
				),
			) === 'invalid_grant'
		await response.body?.cancel().catch(() => {})
		throw new CredentialLoginFailedError(response.status, {
			invalidGrant,
			providerRetryAfterSeconds,
		})
	}
	const payload = parseJson(
		await readBoundedBody(response, maxExchangeResponseBytes).catch(() => null),
	)
	const token = readPath(payload, exchange.tokenPath)
	if (typeof token !== 'string' || token === '') {
		throw new CredentialLoginFailedError(response.status)
	}
	const expiresIn = exchange.expiresInPath
		? readPath(payload, exchange.expiresInPath)
		: undefined
	const reported =
		typeof expiresIn === 'string' && /^-?\d+(\.\d+)?$/.test(expiresIn.trim())
			? Number(expiresIn)
			: expiresIn
	const seconds =
		typeof reported === 'number' && Number.isFinite(reported)
			? Math.min(reported, maxSessionSeconds)
			: exchange.ttlSeconds
	const expiresAt = Date.now() + seconds * 1000 - sessionExpirySkewMs
	const rotated = exchange.refreshToken
		? readPath(payload, exchange.refreshToken.path)
		: undefined
	return {
		token,
		expiresAt: expiresAt > Date.now() ? expiresAt : null,
		rotatedRefreshToken:
			typeof rotated === 'string' &&
			rotated !== '' &&
			rotated !== fields.get(exchange.refreshToken!.field)
				? rotated
				: null,
	}
}

function remember(key: string, session: Session) {
	sessions.delete(key)
	if (session.expiresAt === null) return
	sessions.set(key, session)
	while (sessions.size > maxCachedSessions) {
		sessions.delete(sessions.keys().next().value!)
	}
}

function placeSession(
	inject: ReturnType<typeof readInject>,
	token: string,
	sessionId: string | null,
): ResolvedLoginSession {
	switch (inject.kind) {
		case 'header': {
			const value = inject.format.replaceAll('{value}', () => token)
			return {
				placement: { kind: 'header', name: inject.name, value },
				substitutedValues: [...new Set([token, value])],
				sessionId,
			}
		}
		case 'query':
			return {
				placement: { kind: 'query', param: inject.param, value: token },
				substitutedValues: [token],
				sessionId,
			}
		default: {
			const exhaustive: never = inject
			throw new Error(`Unhandled session inject: ${String(exhaustive)}`)
		}
	}
}

function credentialHeaderValue(value: string) {
	if (!/^[\x20-\x7e]+$/.test(value)) misconfigured()
	return value
}

async function logoutOnce(url: string, headers: Headers) {
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers,
			redirect: 'manual',
			signal: AbortSignal.timeout(logoutTimeoutMs),
		})
		await response.body?.cancel()
	} catch {
		// Cleanup must not replace the protected request's result or error.
	}
}

/** Audited like a value replacement; the details never carry the value. */
async function auditRotatedValue(
	input: { env: Env; actor: Parameters<typeof optionalOrgAuditWriter>[1] },
	found: { ownerId: string; credentialId: string; name: string },
) {
	try {
		await recordCredentialAudit(
			optionalOrgAuditWriter(input.env, input.actor),
			{
				orgId: found.ownerId,
				credential: {
					id: found.credentialId,
					kind: 'secret',
					name: found.name,
				},
				action: credentialAuditActions.valueReplaced,
				details: { replacedBy: 'login_exchange.refreshToken' },
			},
		)
	} catch {
		// The value already committed; a failed audit row is reported, not thrown.
	}
}

export const loginCredentialResolver: CredentialResolver<'login'> = {
	auditSubject: (credential) => ({
		use: credential.use,
		resourceType: 'secret',
		name: credential.credentialId,
		credentialId: null,
		details: { host: credential.requestUrl.hostname },
	}),
	async resolve(call) {
		const { credential } = call
		let lookup = await findStoredCredential(call, credential.credentialId)
		let exchange: ReturnType<typeof readExchange> | null = null
		let inject: ReturnType<typeof readInject> | null = null
		const authorize = async () => {
			const found = await authorizeStoredCredential(
				call,
				credential.credentialId,
				lookup,
				'login',
			)
			assertHttpsUrl(credential.requestUrl)
			if (
				!credentialHostsAllow(
					found.allowedHosts,
					credential.requestUrl.hostname,
				)
			) {
				throw new CredentialRequestRefusedError(
					'host_not_allowed',
					'This login credential does not sign in to requests for that host.',
				)
			}
			exchange = readExchange(found.configJson, found.allowedHosts)
			const sessionInject = readInject(found.injectJson)
			inject = sessionInject
			if (exchange.singleRequest) {
				if (!credential.registerLogout) {
					throw new CredentialRequestRefusedError(
						'invalid_request',
						'Use a single-request Login directly through credential().fetch().',
					)
				}
				if (credential.requestUrl.origin !== exchange.url.origin) {
					throw new CredentialRequestRefusedError(
						'host_not_allowed',
						'Single-request Login only sends sessions to the login origin.',
					)
				}
				if (
					sessionInject.kind !== 'header' ||
					!isCredentialPlacementHeader(sessionInject.name) ||
					exchange.singleRequest.headers.some(
						({ name }) =>
							name.toLowerCase() === sessionInject.name.toLowerCase(),
					)
				) {
					misconfigured()
				}
				credentialHeaderValue(
					sessionInject.format.replace('{value}', 'session'),
				)
			}
			if (
				credential.expectedInject &&
				JSON.stringify(inject) !== JSON.stringify(credential.expectedInject)
			) {
				throw new CredentialRequestRefusedError(
					'invalid_request',
					'The approved login placement changed.',
				)
			}
		}
		const applyOnce = async (): Promise<ResolvedLoginSession> => {
			// `authorize` returned, so the lookup, exchange, and inject are set.
			const { found, readValue } = lookup!
			const env = call.input.env
			const before = found.revisionFields
			const sessionOptions = {
				env,
				ownerId: found.ownerId,
				credentialId: found.credentialId,
				revision: found.revision,
				isCurrent: async () =>
					(await env.APP_DB.prepare(
						`SELECT 1 FROM secret_entries
						WHERE id = ? AND encrypted_value = ? AND config_json IS ?
							AND allowed_hosts = ? AND inject_json = ?
							AND deleted_at IS NULL`,
					)
						.bind(
							found.credentialId,
							before.encryptedValue,
							before.configJson,
							before.allowedHostsJson,
							before.injectJson,
						)
						.first()) !== null,
			}
			const profile = exchange!.singleRequest
			if (profile) {
				let applied: ResolvedLoginSession | undefined
				await obtainLoginSession({
					...sessionOptions,
					cacheSession: false,
					exchange: async () => {
						const { fields } = readLoginFields(await readValue())
						const headers = new Headers()
						for (const { name, field } of profile.headers) {
							headers.set(name, credentialHeaderValue(fields.get(field) ?? ''))
						}
						const { token } = await runExchange(exchange!, fields)
						const placed = placeSession(inject!, token, null)
						if (placed.placement.kind !== 'header') misconfigured()
						const { name, value } = placed.placement
						headers.set(name, credentialHeaderValue(value))
						credential.registerLogout!(() =>
							logoutOnce(profile.logoutUrl, headers),
						)
						applied = {
							...placed,
							singleRequestHeaders: headers,
							substitutedValues: [
								...new Set([...placed.substitutedValues, ...headers.values()]),
							],
						}
						return { token, expiresAt: null }
					},
				})
				if (!applied) misconfigured()
				call.subject.details = {
					...call.subject.details,
					session: 'single-request',
				}
				return applied
			}
			const key = `${found.credentialId}|${found.revision}`
			const rejected = credential.rejectedSessionId ?? null
			const cached = sessions.get(key)
			if (rejected) {
				if (cached?.sessionId === rejected) sessions.delete(key)
			} else if (cached?.expiresAt && cached.expiresAt > Date.now()) {
				call.subject.details = { ...call.subject.details, session: 'cached' }
				return placeSession(inject!, cached.token, cached.sessionId)
			}
			const obtain = async () => {
				const obtained = await obtainLoginSession({
					...sessionOptions,
					rejectedSessionId: rejected,
					exchange: async (): Promise<LoginSession> => {
						const { fields, object } = readLoginFields(await readValue())
						const result = await runExchange(exchange!, fields)
						const session = {
							token: result.token,
							expiresAt: result.expiresAt,
						}
						if (!result.rotatedRefreshToken) return session
						const encryptedValue = await encryptSecretValue(
							env,
							JSON.stringify({
								...object,
								[exchange!.refreshToken!.field]: result.rotatedRefreshToken,
							}),
							userSecretContext(found.ownerId),
						)
						return {
							...session,
							replacement: {
								credentialId: found.credentialId,
								encryptedValue,
								revision: await storedCredentialRevision({
									...before,
									encryptedValue,
								}),
								valueStatement: env.APP_DB.prepare(
									`UPDATE secret_entries SET encrypted_value = ?, updated_at = ?
									WHERE id = ? AND encrypted_value = ? AND config_json IS ?
										AND allowed_hosts = ? AND inject_json = ?
										AND deleted_at IS NULL`,
								).bind(
									encryptedValue,
									new Date().toISOString(),
									found.credentialId,
									before.encryptedValue,
									before.configJson,
									before.allowedHostsJson,
									before.injectJson,
								),
							},
						}
					},
				})
				if (obtained.valueReplaced && obtained.source === 'new') {
					await auditRotatedValue(call.input, found)
				}
				return obtained
			}
			const { session, source, sessionId } = await (rejected
				? obtain()
				: pendingSessions.getOrCreate({ cacheKey: key, create: obtain }))
			remember(key, { ...session, sessionId })
			call.subject.details = {
				...call.subject.details,
				session: rejected ? `${source}-after-401` : source,
			}
			return placeSession(inject!, session.token, sessionId)
		}
		return {
			authorize,
			async apply(): Promise<ResolvedLoginSession> {
				try {
					return await applyOnce()
				} catch (error) {
					if (!(error instanceof StaleLoginCredentialError)) throw error
				}
				// Another caller rotated the value; its session is under the new revision.
				lookup = await findStoredCredential(call, credential.credentialId)
				await authorize()
				try {
					return await applyOnce()
				} catch (error) {
					if (error instanceof StaleLoginCredentialError) {
						throw new CredentialLoginFailedError(null)
					}
					throw error
				}
			},
		}
	},
	isFound: () => true,
}
