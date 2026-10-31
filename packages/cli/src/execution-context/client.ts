import {
	ecpRunHeader,
	ecpSignatureHeader,
	formatEcpSignatureHeader,
	importEd25519PrivateKey,
	signEcpHttpRequest,
	verifyServerKeySet,
	type Ed25519PrivateJwk,
	type EcpPublishedKey,
	type EcpCryptoKey,
} from '@kody-internal/shared/execution-context-protocol/index.ts'

export const executionContextsPath = '/v1/execution-contexts'

/** Old logins lack execution context scopes; never widen them silently. */
export const reloginHint =
	'Run `kody login` again, then retry `kody context register`.'

export class ExecutionContextApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string | null,
		readonly reason: string | null = null,
	) {
		super(message)
	}
}

/** Kody will never accept this context's key again: stop, do not retry. */
export function isPermanentContextRefusal(error: unknown) {
	return (
		error instanceof ExecutionContextApiError &&
		(error.status === 401 || error.status === 403) &&
		(error.reason === 'revoked' || error.reason === 'unknown_context')
	)
}

/**
 * The execution-contexts experiment is off for this account: say how to turn
 * it on instead of retrying or echoing a bare 403.
 */
export function experimentOffError(apiUrl: string) {
	const origin = new URL(apiUrl).origin
	return new ExecutionContextApiError(
		[
			'Execution contexts are an experiment that is off for this account.',
			`Turn them on at ${origin}/account/experiments, or ask your agent to call experimentSet with { "experiment": "execution-contexts", "enabled": true }.`,
			`Then run this command again. Guide: ${origin}/docs/execution-contexts`,
		].join('\n'),
		403,
		'feature_disabled',
	)
}

export function isExperimentOffError(error: unknown) {
	return (
		error instanceof ExecutionContextApiError &&
		error.code === 'feature_disabled'
	)
}

async function readError(response: Response) {
	const text = await response.text()
	let code: string | null = null
	let reason: string | null = null
	let message = text || `HTTP ${response.status}`
	try {
		const body = JSON.parse(text) as {
			error?:
				| { code?: string; message?: string; details?: { reason?: unknown } }
				| string
			message?: string
		}
		if (typeof body.error === 'string') {
			code = body.error
			message = body.message ?? body.error
		} else if (body.error) {
			code = body.error.code ?? null
			message = body.error.message ?? message
			if (typeof body.error.details?.reason === 'string') {
				reason = body.error.details.reason
			}
		}
	} catch {}
	return new ExecutionContextApiError(message, response.status, code, reason)
}

/** Fetch with the context's Ed25519 HTTP signature (no bearer token). */
export async function signedFetch(input: {
	apiUrl: string
	ecid: string
	privateKey: EcpCryptoKey
	method: string
	pathAndQuery: string
	body?: Uint8Array | string
	runId?: string
	headers?: Record<string, string>
	fetchFn?: typeof fetch
	signal?: AbortSignal
}) {
	const body = input.body ?? ''
	const signature = await signEcpHttpRequest({
		ec: input.ecid,
		method: input.method,
		pathAndQuery: input.pathAndQuery,
		body,
		privateKey: input.privateKey,
	})
	return (input.fetchFn ?? fetch)(new URL(input.pathAndQuery, input.apiUrl), {
		method: input.method,
		signal: input.signal,
		headers: {
			...input.headers,
			[ecpSignatureHeader]: formatEcpSignatureHeader(signature),
			...(input.runId ? { [ecpRunHeader]: input.runId } : {}),
		},
		...(input.method === 'GET' || input.method === 'HEAD'
			? {}
			: { body: typeof body === 'string' ? body : Buffer.from(body) }),
	})
}

export async function generateContextKey() {
	const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
		'sign',
		'verify',
	])) as unknown as { privateKey: EcpCryptoKey; publicKey: EcpCryptoKey }
	const privateJwk = (await crypto.subtle.exportKey(
		'jwk',
		pair.privateKey,
	)) as { x?: string; d?: string }
	const publicKeyJwk = {
		kty: 'OKP' as const,
		crv: 'Ed25519' as const,
		x: String(privateJwk.x),
	}
	const privateKeyJwk: Ed25519PrivateJwk = {
		...publicKeyJwk,
		d: String(privateJwk.d),
	}
	return { publicKeyJwk, privateKeyJwk }
}

export function importContextKey(privateJwk: unknown) {
	return importEd25519PrivateKey(privateJwk as Ed25519PrivateJwk)
}

export type RegistrationResult = {
	ecid: string
	name: string
	thumbprint: string
	owner: { orgId: string; orgSlug: string | null }
	grant: unknown
	nextSteps?: Array<{ text?: string; cli?: string }>
	notice?: string
}

/** Challenge, then a registration signed by the new key (proof of possession). */
export async function registerContext(input: {
	apiUrl: string
	token: string
	org?: string
	name: string
	publicKeyJwk: { kty: 'OKP'; crv: 'Ed25519'; x: string }
	privateKey: EcpCryptoKey
	thumbprint: string
	capabilities: Record<string, unknown>
	client: { name: string; version: string }
	fetchFn?: typeof fetch
}): Promise<RegistrationResult> {
	const fetchFn = input.fetchFn ?? fetch
	const query = input.org ? `?org=${encodeURIComponent(input.org)}` : ''
	const auth = { authorization: `Bearer ${input.token}` }
	const challengeResponse = await fetchFn(
		new URL(
			`${executionContextsPath}/registration-challenge${query}`,
			input.apiUrl,
		),
		{ method: 'POST', headers: auth },
	)
	if (!challengeResponse.ok) throw await registrationError(challengeResponse)
	const { challenge } = (await challengeResponse.json()) as {
		challenge: string
	}
	const body = JSON.stringify({
		name: input.name,
		publicKeyJwk: input.publicKeyJwk,
		challenge,
		capabilities: input.capabilities,
		client: input.client,
	})
	const response = await signedFetch({
		apiUrl: input.apiUrl,
		ecid: input.thumbprint,
		privateKey: input.privateKey,
		method: 'POST',
		pathAndQuery: `${executionContextsPath}${query}`,
		body,
		headers: { ...auth, 'content-type': 'application/json' },
		fetchFn,
	})
	if (!response.ok) throw await registrationError(response)
	return (await response.json()) as RegistrationResult
}

async function registrationError(response: Response) {
	const error = await readError(response)
	if (
		error.code === 'credential_scope' ||
		error.message.includes('predates execution context permissions')
	) {
		return new ExecutionContextApiError(
			error.message.includes('kody login')
				? error.message
				: `${error.message.trim()} ${reloginHint}`,
			error.status,
			error.code,
		)
	}
	return error
}

export async function requestConnectTicket(input: {
	apiUrl: string
	ecid: string
	privateKey: EcpCryptoKey
	fetchFn?: typeof fetch
	signal?: AbortSignal
}) {
	const response = await signedFetch({
		...input,
		method: 'POST',
		pathAndQuery: `${executionContextsPath}/connect-ticket`,
		body: '{}',
		headers: { 'content-type': 'application/json' },
	})
	if (!response.ok) throw await readError(response)
	return (await response.json()) as { ticket: string; expiresAt: string }
}

/**
 * Host commands opt-in (ADR 0093), signed with the context key so only this
 * machine can turn commands on. Omit `enabled` to read the current state.
 */
export async function setContextCommands(input: {
	apiUrl: string
	ecid: string
	privateKey: EcpCryptoKey
	enabled?: boolean
	fetchFn?: typeof fetch
	signal?: AbortSignal
}) {
	const response = await signedFetch({
		apiUrl: input.apiUrl,
		ecid: input.ecid,
		privateKey: input.privateKey,
		...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
		...(input.signal ? { signal: input.signal } : {}),
		method: 'POST',
		pathAndQuery: `${executionContextsPath}/commands`,
		body: JSON.stringify(
			input.enabled === undefined ? {} : { enabled: input.enabled },
		),
		headers: { 'content-type': 'application/json' },
	})
	if (!response.ok) throw await readError(response)
	return (await response.json()) as {
		id: string
		name: string
		commands: { enabled: boolean; enabledAt?: string | null }
		grantVersion: number
	}
}

/** Server frame keys, trusted only when signed by a pinned root key. */
export async function fetchServerKeys(input: {
	apiUrl: string
	fetchFn?: typeof fetch
	now?: number
}): Promise<Array<EcpPublishedKey>> {
	const response = await (input.fetchFn ?? fetch)(
		new URL(`${executionContextsPath}/server-keys`, input.apiUrl),
	)
	if (!response.ok) throw await readError(response)
	const set = await verifyServerKeySet({ document: await response.json() })
	if (!set) {
		throw new Error(
			'Kody server keys failed root signature verification. Refusing to connect.',
		)
	}
	const now = input.now ?? Date.now()
	return set.keys.filter((key) => key.notAfter > now)
}

export async function apiJson(input: {
	apiUrl: string
	token: string
	org?: string
	method: string
	path: string
	body?: unknown
	fetchFn?: typeof fetch
}) {
	const url = new URL(input.path, input.apiUrl)
	if (input.org) url.searchParams.set('org', input.org)
	const response = await (input.fetchFn ?? fetch)(url, {
		method: input.method,
		headers: {
			authorization: `Bearer ${input.token}`,
			...(input.body === undefined
				? {}
				: { 'content-type': 'application/json' }),
		},
		...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
	})
	if (!response.ok) throw await readError(response)
	return (await response.json()) as Record<string, unknown>
}
