import {
	ecpDefaultGrant,
	ecpSignatureHeader,
	ed25519JwkThumbprint,
	importEd25519PublicKey,
	normalizeEd25519PublicJwk,
	parseEcpSignatureHeader,
	parseFrameSigningKeys,
	sha256Base64Url,
	verifyEcpHttpSignature,
	type Ed25519PublicJwk,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import { authorizeOrgWide } from '#worker/authorization/authorize.ts'
import { isExecutionContextsEnabledFor } from './flag.ts'
import { authenticateApiRequest } from '#worker/open-api/authenticate.ts'
import { ApiError, invalidRequest } from '#worker/open-api/errors.ts'
import { registrationAuthorizationError } from './errors.ts'
import productionServerKeys from './server-keys.production.json'
import testServerKeys from './server-keys.local.json'
import {
	chainCounts,
	consumeRegistrationChallenge,
	createRegistrationChallenge,
	getExecutionContext,
	getExecutionContextByThumbprint,
	insertExecutionContext,
	newExecutionContextId,
	parseGrant,
	parsePublicKey,
	sessionStub,
	type ExecutionContextRow,
} from './store.ts'
import { registrationNextSteps, registrationTrustNotice } from './trust-copy.ts'

/** Key-authenticated routes (protocol 3.1) that sit outside the Bearer pipeline. */
export const executionContextsBasePath = '/v1/execution-contexts'
const maxRegisterBodyBytes = 64 * 1024
const contextNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/

export function isExecutionContextKeyRoute(method: string, pathname: string) {
	if (pathname === executionContextsBasePath) return method === 'POST'
	return (
		pathname === `${executionContextsBasePath}/registration-challenge` ||
		pathname === `${executionContextsBasePath}/connect-ticket` ||
		pathname === `${executionContextsBasePath}/connect` ||
		pathname === `${executionContextsBasePath}/server-keys`
	)
}

export function featureDisabled() {
	return new ApiError({
		status: 403,
		code: 'feature_disabled',
		message:
			'Execution contexts are behind the execution-contexts feature flag, which is off for this account.',
	})
}

function json(body: unknown, init: ResponseInit = {}) {
	return Response.json(body, {
		...init,
		headers: { 'Cache-Control': 'no-store', ...init.headers },
	})
}

const testServerKids = new Set(documentKids(testServerKeys))

function documentKids(document: { p: string }) {
	try {
		const payload = JSON.parse(
			atob(document.p.replaceAll('-', '+').replaceAll('_', '/')),
		) as { keys: Array<{ kid: string }> }
		return payload.keys.map((key) => key.kid)
	} catch {
		return []
	}
}

/**
 * The committed key set that publishes this deployment's frame signing key:
 * the test set only when the configured signer is a test key, so production
 * (and any misconfigured env) serves the production set.
 */
export function serverKeySetDocument(env: Pick<Env, 'ECP_FRAME_SIGNING_KEYS'>) {
	let kids: Array<string> = []
	try {
		kids = env.ECP_FRAME_SIGNING_KEYS
			? parseFrameSigningKeys(env.ECP_FRAME_SIGNING_KEYS).map((key) => key.kid)
			: []
	} catch {
		kids = []
	}
	return kids.length > 0 && kids.every((kid) => testServerKids.has(kid))
		? testServerKeys
		: productionServerKeys
}

async function readBody(request: Request) {
	const bytes = new Uint8Array(await request.arrayBuffer())
	if (bytes.byteLength > maxRegisterBodyBytes) {
		throw new ApiError({
			status: 413,
			code: 'payload_too_large',
			message: 'Request body is too large.',
		})
	}
	return bytes
}

function signatureError(code: string, status = 401) {
	return new ApiError({
		status,
		code: 'unauthorized',
		message: `Execution context signature rejected (${code}).`,
		details: { reason: code },
	})
}

async function verifySigned(input: {
	request: Request
	url: URL
	body: Uint8Array
	publicKeyJwk: Ed25519PublicJwk
	expectedEc: string
}) {
	const signature = parseEcpSignatureHeader(
		input.request.headers.get(ecpSignatureHeader),
	)
	if (!signature) throw signatureError('missing_signature')
	if (signature.ec !== input.expectedEc) throw signatureError('wrong_context')
	const verdict = await verifyEcpHttpSignature({
		signature,
		method: input.request.method,
		pathAndQuery: `${input.url.pathname}${input.url.search}`,
		body: input.body,
		publicKey: await importEd25519PublicKey(input.publicKeyJwk),
	})
	if (verdict !== 'ok') throw signatureError(verdict)
	return signature
}

function snapshotOf(row: ExecutionContextRow) {
	return {
		ecid: row.id,
		name: row.name,
		orgId: row.org_id,
		operatorUserId: row.operator_user_id,
		publicKeyJwk: parsePublicKey(row),
		grant: parseGrant(row),
		grantVersion: row.grant_version,
	}
}

export async function handleExecutionContextKeyRoute(input: {
	request: Request
	url: URL
	env: Env
	appOrigin: string
	waitUntil: (promise: Promise<unknown>) => void
}): Promise<Response> {
	const { request, url, env } = input
	const path = url.pathname
	if (path === `${executionContextsBasePath}/server-keys`) {
		if (request.method !== 'GET') throw methodNotAllowed('GET')
		return Response.json(serverKeySetDocument(env), {
			headers: { 'Cache-Control': 'public, max-age=300' },
		})
	}
	if (path === `${executionContextsBasePath}/connect`) {
		if (request.method !== 'GET') throw methodNotAllowed('GET')
		const ticket = url.searchParams.get('ticket') ?? ''
		const ecid = ticket.split('.')[0] ?? ''
		if (!ecid.startsWith('ec_')) throw signatureError('bad_ticket')
		return await sessionStub(env, ecid).fetch(request)
	}
	if (path === `${executionContextsBasePath}/connect-ticket`) {
		if (request.method !== 'POST') throw methodNotAllowed('POST')
		const body = await readBody(request)
		const signature = parseEcpSignatureHeader(
			request.headers.get(ecpSignatureHeader),
		)
		if (!signature) throw signatureError('missing_signature')
		const row = await getExecutionContext(env.APP_DB, signature.ec)
		if (!row) throw signatureError('unknown_context')
		await verifySigned({
			request,
			url,
			body,
			publicKeyJwk: parsePublicKey(row),
			expectedEc: row.id,
		})
		if (row.revoked_at) {
			throw new ApiError({
				status: 403,
				code: 'unauthorized',
				message: `This execution context was revoked (${row.revoked_reason ?? 'revoked'}).`,
				details: { reason: 'revoked' },
			})
		}
		const issued = await sessionStub(env, row.id).issueConnectTicket({
			snapshot: snapshotOf(row),
			nonce: signature.n,
		})
		if (!issued.ok) {
			if (issued.code === 'rate_limited') {
				throw new ApiError({
					status: 429,
					code: 'rate_limited',
					message: 'Too many connect tickets. Back off and retry.',
				})
			}
			throw signatureError(issued.code)
		}
		return json({
			ticket: issued.ticket,
			expiresAt: new Date(issued.expiresAt).toISOString(),
		})
	}

	const api = await authenticateApiRequest({
		request,
		env,
		appOrigin: input.appOrigin,
		waitUntil: input.waitUntil,
		allowMcpOauth: true,
	})
	const caller = api.callerContext.request
	if (!caller?.actor) throw signatureError('person_required', 403)
	const userId = caller.actor.userId
	if (!(await isExecutionContextsEnabledFor(env.APP_DB, userId))) {
		throw featureDisabled()
	}
	try {
		await authorizeOrgWide({ env, request: caller }, 'execution_context:create')
	} catch (error) {
		throw registrationAuthorizationError(error)
	}

	if (path === `${executionContextsBasePath}/registration-challenge`) {
		if (request.method !== 'POST') throw methodNotAllowed('POST')
		const challenge = randomToken()
		const now = Date.now()
		await createRegistrationChallenge(env.APP_DB, {
			challengeHash: await sha256Base64Url(challenge),
			userId,
			orgId: caller.org.id,
			now,
		})
		return json({
			challenge,
			expiresAt: new Date(now + 5 * 60_000).toISOString(),
		})
	}

	// POST /v1/execution-contexts: register.
	const body = await readBody(request)
	let parsed: {
		name?: unknown
		publicKeyJwk?: unknown
		challenge?: unknown
		capabilities?: unknown
		client?: { name?: unknown; version?: unknown }
	}
	try {
		parsed = JSON.parse(new TextDecoder().decode(body))
	} catch {
		throw invalidRequest('Body must be JSON.')
	}
	const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
	if (!contextNamePattern.test(name)) {
		throw invalidRequest(
			'name must be 1-63 lowercase letters, digits or dashes, starting with a letter or digit.',
		)
	}
	let publicKeyJwk: Ed25519PublicJwk | null = null
	try {
		publicKeyJwk = normalizeEd25519PublicJwk(parsed.publicKeyJwk)
	} catch {
		publicKeyJwk = null
	}
	if (!publicKeyJwk) {
		throw invalidRequest('publicKeyJwk must be an Ed25519 public JWK.')
	}
	const thumbprint = await ed25519JwkThumbprint(publicKeyJwk)
	await verifySigned({
		request,
		url,
		body,
		publicKeyJwk,
		expectedEc: thumbprint,
	})
	if (typeof parsed.challenge !== 'string') {
		throw invalidRequest('challenge is required.')
	}
	const consumed = await consumeRegistrationChallenge(env.APP_DB, {
		challengeHash: await sha256Base64Url(parsed.challenge),
		now: Date.now(),
	})
	if (
		!consumed ||
		consumed.user_id !== userId ||
		consumed.org_id !== caller.org.id
	) {
		throw signatureError('challenge_invalid')
	}
	if (await getExecutionContextByThumbprint(env.APP_DB, thumbprint)) {
		throw new ApiError({
			status: 409,
			code: 'invalid_request',
			message:
				'This key is already registered. Rotate the key with `kody context rotate-key` or revoke the old context first.',
		})
	}
	const id = newExecutionContextId()
	const grant = ecpDefaultGrant
	const row = {
		id,
		org_id: caller.org.id,
		operator_user_id: userId,
		name,
		public_key_jwk: JSON.stringify(publicKeyJwk),
		thumbprint,
		created_at: new Date().toISOString(),
		client_name:
			typeof parsed.client?.name === 'string'
				? parsed.client.name.slice(0, 80)
				: null,
		client_version:
			typeof parsed.client?.version === 'string'
				? parsed.client.version.slice(0, 40)
				: null,
		capabilities_json: parsed.capabilities
			? JSON.stringify(parsed.capabilities).slice(0, 8192)
			: null,
		grant_json: JSON.stringify(grant),
		grant_version: 1,
	}
	try {
		await insertExecutionContext(env.APP_DB, row)
	} catch (error) {
		if (String(error).includes('UNIQUE')) {
			throw new ApiError({
				status: 409,
				code: 'invalid_request',
				message: `A context named ${name} already exists in this org. Pick another name.`,
				cause: error,
			})
		}
		throw error
	}
	const counts = await chainCounts(env.APP_DB, [id])
	return json(
		{
			ecid: id,
			name,
			thumbprint,
			owner: { orgId: caller.org.id, orgSlug: caller.org.slug },
			grant,
			grantVersion: 1,
			currentServerKid: currentServerKid(env),
			chainUsage: { inMyChain: false, chainCount: counts.get(id) ?? 0 },
			nextSteps: registrationNextSteps({ name }),
			notice: registrationTrustNotice(),
		},
		{ status: 201 },
	)
}

function currentServerKid(env: Pick<Env, 'ECP_FRAME_SIGNING_KEYS'>) {
	return documentKids(serverKeySetDocument(env))[0] ?? null
}

function randomToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '')
}

function methodNotAllowed(allow: string) {
	return new ApiError({
		status: 405,
		code: 'method_not_allowed',
		message: `Use ${allow}.`,
		headers: { Allow: allow },
	})
}
