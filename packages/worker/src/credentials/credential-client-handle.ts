/**
 * The opaque handle a `credential()` client carries (ADR 0068). It names one
 * credential pick and is signed by the host, so code can pass it around but
 * cannot forge one or point it at another credential. It is bound to one run
 * (`binding`), its org and actor, and expires; it holds no value. Every use
 * still goes through `resolveCredential`, which authorizes again.
 */
import {
	base64UrlToBytes,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { z } from 'zod'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { packageCredentialKindValues } from '#worker/package-registry/types.ts'

const handlePrefix = 'kch1.'
const handleLifetimeMs = 12 * 60 * 60 * 1000
const signingInfo = new TextEncoder().encode('kody/credential-client-handle/v1')

const handlePayloadSchema = z.object({
	id: z.string().min(1),
	kind: z.enum(packageCredentialKindValues),
	name: z.string(),
	scope: z.enum(['org', 'personal']),
	org: z.string().min(1),
	actor: z.string().min(1),
	binding: z.string().min(1),
	/**
	 * Opened for an `ownerCredentialForVisitors` need: `actor` is the app's
	 * credential authority, not the run's viewer. `needKey` is the declared
	 * need this handle fills so later uses can re-check the approval list.
	 */
	ownerCredentialForVisitors: z.literal(true).optional(),
	needKey: z.string().min(1).max(100).optional(),
	/**
	 * Opened as a package app's runs-as person: `actor` is that person, and
	 * each use re-checks they still run the app.
	 */
	runsAs: z.literal(true).optional(),
	/**
	 * Opened for a legacy visitor need: each use re-checks the visitor's live
	 * consent for it.
	 */
	visitorNeed: z.string().min(1).max(100).optional(),
	/**
	 * Opened on an executor credential: each use re-checks consent and the
	 * credential mapping on the visitor's live grant.
	 */
	executorNeed: z.string().min(1).max(100).optional(),
	exp: z.number(),
})

export type CredentialClientHandle = z.infer<typeof handlePayloadSchema>

/**
 * What a handle is bound to: one hosted run, or one CapabilityProxy
 * credential for CLI `--local`, which has no run on the host.
 */
export function capabilityProxyCredentialClientBinding(
	request: RequestContext,
) {
	return `proxy:${request.credential.kind}:${request.credential.id ?? 'none'}`
}

export function newRunCredentialClientBinding() {
	return `run:${crypto.randomUUID()}`
}

const signingKeys = new Map<string, Promise<CryptoKey>>()

function signingKey(secretStoreKey: string) {
	let key = signingKeys.get(secretStoreKey)
	if (!key) {
		key = (async () => {
			const base = await crypto.subtle.importKey(
				'raw',
				new TextEncoder().encode(secretStoreKey),
				'HKDF',
				false,
				['deriveKey'],
			)
			return await crypto.subtle.deriveKey(
				{
					name: 'HKDF',
					hash: 'SHA-256',
					salt: new Uint8Array(),
					info: signingInfo,
				},
				base,
				{ name: 'HMAC', hash: 'SHA-256', length: 256 },
				false,
				['sign', 'verify'],
			)
		})()
		signingKeys.set(secretStoreKey, key)
	}
	return key
}

export async function signCredentialClientHandle(input: {
	env: Pick<Env, 'SECRET_STORE_KEY'>
	handle: Omit<CredentialClientHandle, 'exp'>
	now?: number
}) {
	// Verify refuses an empty binding, so a handle signed with one could
	// never be used. Refuse to issue it instead.
	if (!input.handle.binding.trim()) {
		throw new Error('A credential client handle needs a run binding.')
	}
	const payload: CredentialClientHandle = {
		...input.handle,
		exp: (input.now ?? Date.now()) + handleLifetimeMs,
	}
	const body = bytesToBase64Url(
		new TextEncoder().encode(JSON.stringify(payload)),
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		await signingKey(input.env.SECRET_STORE_KEY),
		new TextEncoder().encode(body),
	)
	return `${handlePrefix}${body}.${bytesToBase64Url(new Uint8Array(signature))}`
}

export class CredentialClientHandleError extends Error {
	constructor() {
		super(
			'This credential client is not valid here. Clients work only in the run that opened them; call credential() again.',
		)
		this.name = 'CredentialClientHandleError'
	}
}

/**
 * The handle's pick when its signature holds, it has not expired, and it was
 * opened by this actor in this org for this run. A handle opened for an
 * `ownerCredentialForVisitors` need must match `ownerCredentialRequest`
 * instead of `request`. Otherwise it throws, without saying which check
 * failed.
 */
export async function verifyCredentialClientHandle(input: {
	env: Pick<Env, 'SECRET_STORE_KEY'>
	token: string
	request: RequestContext | null
	binding: string | null | undefined
	/** The run's credential authority, when it has one. */
	ownerCredentialRequest?: () => Promise<RequestContext | null>
	/** Package apps: the live runs-as person, for a `runsAs` handle. */
	runsAsRequest?: () => Promise<RequestContext | null>
	/** Package apps: the visitor, while their consent covers this need. */
	visitorNeedRequest?: (needKey: string) => Promise<RequestContext | null>
	/** Package apps: the visitor grant authorizing this need. */
	visitorNeedGrant?: (
		needKey: string,
	) => Promise<{ request: RequestContext; grantId: string } | null>
	now?: number
}): Promise<CredentialClientHandle> {
	const fail = () => new CredentialClientHandleError()
	const { token, binding } = input
	if (!binding || !token.startsWith(handlePrefix)) {
		throw fail()
	}
	const [body, signature, extra] = token.slice(handlePrefix.length).split('.')
	if (!body || !signature || extra !== undefined) throw fail()
	let valid = false
	try {
		valid = await crypto.subtle.verify(
			'HMAC',
			await signingKey(input.env.SECRET_STORE_KEY),
			base64UrlToBytes(signature),
			new TextEncoder().encode(body),
		)
	} catch {
		throw fail()
	}
	if (!valid) throw fail()
	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body)))
	} catch {
		throw fail()
	}
	const handle = handlePayloadSchema.safeParse(parsed)
	if (
		!handle.success ||
		handle.data.exp <= (input.now ?? Date.now()) ||
		handle.data.binding !== binding
	) {
		throw fail()
	}
	const request = handle.data.ownerCredentialForVisitors
		? ((await input.ownerCredentialRequest?.()) ?? null)
		: handle.data.runsAs
			? ((await input.runsAsRequest?.()) ?? null)
			: handle.data.executorNeed
				? ((await input.visitorNeedGrant?.(handle.data.executorNeed))
						?.request ?? null)
				: handle.data.visitorNeed
					? ((await input.visitorNeedGrant?.(handle.data.visitorNeed))
							?.request ??
						(await input.visitorNeedRequest?.(handle.data.visitorNeed)) ??
						null)
					: input.request
	if (
		!request?.actor ||
		handle.data.org !== request.org.id ||
		handle.data.actor !== request.actor.userId
	) {
		throw fail()
	}
	return handle.data
}
