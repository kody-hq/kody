/**
 * The `login` credential kind (ADR 0068): the value holds login fields (for
 * example a username and password) as one JSON object, and the credential's
 * `config_json` holds the exchange that turns them into a session token. The
 * gateway runs the exchange, keeps the session for its lifetime (encrypted in
 * `login_credential_sessions`, with a per-isolate front cache), and places it
 * on a request to one of the credential's hosts by the credential's `inject`.
 * Neither the fields, the login response, nor the session ever reach code.
 */
import { z } from 'zod'
import { readBoundedBody } from '#mcp/capabilities/integrations/read-bounded-body.ts'
import {
	assertHttpsUrl,
	credentialHostsAllow,
	CredentialLoginFailedError,
	CredentialRequestRefusedError,
} from './credential-request.ts'
import { type CredentialResolver } from './credential-resolver.ts'
import { type LoginSession, obtainLoginSession } from './login-session-store.ts'
import {
	authorizeStoredCredential,
	findStoredCredential,
} from './stored-credential.ts'

const maxSessionSeconds = 24 * 60 * 60
const sessionExpirySkewMs = 30_000
const exchangeTimeoutMs = 30_000
const maxCachedSessions = 500
const maxExchangeResponseBytes = 64 * 1024

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
	})
	.strict()

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
}

type Session = LoginSession

/**
 * Front cache of sessions by credential id and revision (a digest of the
 * stored ciphertext, exchange, hosts, and inject), so any of those edits
 * starts a new session. The durable copy is in `login_credential_sessions`;
 * `authorize` still runs on every resolution before a session is used.
 */
const sessions = new Map<string, Session>()
const pendingSessions = new Map<
	string,
	Promise<{ session: Session; source: 'stored' | 'new' }>
>()

export function clearLoginSessionsForTests() {
	sessions.clear()
	pendingSessions.clear()
}

function misconfigured(): never {
	throw new CredentialRequestRefusedError(
		'invalid_request',
		"This login credential's exchange is not set up correctly. Its owner can fix it.",
	)
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
	return fields
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
): Promise<Session> {
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
		await response.body?.cancel()
		throw new CredentialLoginFailedError(response.status)
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
	return { token, expiresAt: expiresAt > Date.now() ? expiresAt : null }
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
): ResolvedLoginSession {
	switch (inject.kind) {
		case 'header': {
			const value = inject.format.replaceAll('{value}', () => token)
			return {
				placement: { kind: 'header', name: inject.name, value },
				substitutedValues: [...new Set([token, value])],
			}
		}
		case 'query':
			return {
				placement: { kind: 'query', param: inject.param, value: token },
				substitutedValues: [token],
			}
		default: {
			const exhaustive: never = inject
			throw new Error(`Unhandled session inject: ${String(exhaustive)}`)
		}
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
		const lookup = await findStoredCredential(call, credential.credentialId)
		let exchange: ReturnType<typeof readExchange> | null = null
		let inject: ReturnType<typeof readInject> | null = null
		return {
			async authorize() {
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
				inject = readInject(found.injectJson)
			},
			async apply(): Promise<ResolvedLoginSession> {
				// `authorize` returned, so the lookup, exchange, and inject are set.
				const { found, readValue } = lookup!
				const key = `${found.credentialId}|${found.revision}`
				const cached = sessions.get(key)
				if (cached?.expiresAt && cached.expiresAt > Date.now()) {
					call.subject.details = { ...call.subject.details, session: 'cached' }
					return placeSession(inject!, cached.token)
				}
				let pending = pendingSessions.get(key)
				if (!pending) {
					pending = obtainLoginSession({
						env: call.input.env,
						ownerId: found.ownerId,
						credentialId: found.credentialId,
						revision: found.revision,
						exchange: async () =>
							runExchange(exchange!, readLoginFields(await readValue())),
					})
					pendingSessions.set(key, pending)
				}
				try {
					const { session, source } = await pending
					remember(key, session)
					call.subject.details = { ...call.subject.details, session: source }
					return placeSession(inject!, session.token)
				} finally {
					pendingSessions.delete(key)
				}
			},
		}
	},
	isFound: () => true,
}
