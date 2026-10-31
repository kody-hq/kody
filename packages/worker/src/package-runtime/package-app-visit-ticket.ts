/**
 * Short-lived signed visit ticket for one package-app request.
 *
 * Visitor identity and authority no longer live on the cached worker template.
 * The host mints this ticket after authenticating the visitor, sets it on the
 * request (inbound `X-Kody-*` already stripped), and the wrapper attaches it
 * to every bridge and gateway call. The ticket is HMAC-signed with a
 * host-held key package code never sees, bound to one request nonce, and
 * capped at 60 seconds. Verify is HMAC + audience + not burned + (unexpired
 * or still live on this isolate). Live is not required: mint and verify may
 * run on different isolates. Reuse after the request ends, after expiry
 * without a live nonce, on another app, commit, or host, or with a forged
 * signature is refused.
 *
 * A ticket records the live grant and scopes observed at serve time. Visitor
 * credential access checks the grant again before each use.
 *
 * A request with no acting visitor gets an anonymous ticket (`kva1.`): same
 * signing, audience, nonce, and lifetime rules, but it names nobody. It only
 * carries the request's credential-client binding, so handles opened by an
 * anonymous request work on every bridge and gateway call of that request and
 * nowhere else. Every identity, storage, and capability path treats it as no
 * visit.
 */
import {
	base64UrlToBytes,
	bytesToBase64Url,
	utf8ToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import {
	isOrgPermission,
	type OrgPermission,
} from '@kody-internal/shared/org-permissions.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	type OrgRole,
	type RequestBilling,
	type RequestContext,
	type RequestCredential,
} from '@kody-internal/shared/request-context.ts'
import { type RuntimePackageAppVisitor } from '@kody-internal/shared/runtime-worker.ts'
import { newRunCredentialClientBinding } from '#worker/credentials/credential-client-handle.ts'

export const packageAppVisitTicketHeaderName = 'X-Kody-Visit-Ticket'
export const packageAppVisitTicketTtlMs = 60_000
/**
 * How long a mint isolate may keep a nonce live after mint so the same
 * isolate can still accept the ticket past the 60s cap (streamed bodies,
 * waitUntil, outbound fetch). Forgotten if `endPackageAppVisit` never runs.
 */
export const packageAppVisitLiveHoldMs = 5 * 60_000
export const packageAppVisitTicketPrefix = 'kvt1.'
export const packageAppAnonymousVisitTicketPrefix = 'kva1.'

const ticketPurpose = 'kody-package-app-visit@v1'
const anonymousTicketPurpose = 'kody-package-app-anonymous-visit@v1'
const signingInfo = new TextEncoder().encode('kody-package-app-visit-ticket-v1')
const orgRoles: ReadonlyArray<OrgRole> = ['owner', 'member', 'billing']

export type PackageAppVisitAudience = {
	host: string
	packageId: string
	kodyId: string
	sourceId: string
	publishedCommit: string | null
}

export type PackageAppVisitClaims = {
	visitor: RuntimePackageAppVisitor
	owner: {
		userId: OwnerId
		orgSlug: string | null
		email: string
		displayName: string
	}
	audience: PackageAppVisitAudience
	nonce: string
	credentialClientBinding: string
	/** The live Sign in with Kody grant used to mint this request. */
	grantId: string | null
	/** Scopes the visitor granted when this request began. */
	scopes: ReadonlyArray<string>
	/**
	 * The visitor's request credential scopes. Rebuilt requests keep them;
	 * null does not narrow.
	 */
	credentialScopes?: ReadonlyArray<OrgPermission> | null
	/** The visitor credential's profile (ADR 0092); null is the live mirror. */
	credentialProfileId?: string | null
	/** That profile's chain at mint: ids, root first (attribution). */
	credentialProfileChain?: ReadonlyArray<string> | null
	/**
	 * A visitor from outside the owning org: the ticket only opens the
	 * executor credentials they approved. Every other path treats the request
	 * as anonymous plus identity.
	 */
	executorOnly?: boolean
	/**
	 * The visitor's own org pays for this request's metered work (a visit
	 * from another org to an internal app, ADR 0095). Absent: the owner pays.
	 */
	billing?: RequestBilling
	exp: number
}

/** A verified anonymous ticket: one request's binding, and nobody. */
export type PackageAppAnonymousVisitClaims = {
	visitor: null
	executorOnly?: undefined
	audience: PackageAppVisitAudience
	nonce: string
	credentialClientBinding: string
	exp: number
}

export type PackageAppVerifiedVisit =
	| PackageAppVisitClaims
	| PackageAppAnonymousVisitClaims

export type PackageAppRequestVisit = {
	ticket: string | null
	nonce: string | null
	visitor: RuntimePackageAppVisitor | null
	request: RequestContext | null
	credentialClientBinding: string
	email: string
	displayName: string
	claims: PackageAppVisitClaims | null
}

type StoredVisitTicket = {
	v: 1
	nonce: string
	exp: number
	host: string
	pkg: string
	kid: string
	src: string
	commit: string | null
	oid: string
	ou: string | null
	oe: string
	od: string
	sub: string
	vu: string
	role: OrgRole | null
	binding: string
	grantId: string | null
	scopes: Array<string>
	cs?: Array<string> | null
	cpi?: string | null
	cpc?: Array<string> | null
	xo?: true
	/** Billed org id when it is not the owner (ADR 0095). */
	bo?: string
}

type StoredAnonymousVisitTicket = {
	v: 1
	anon: true
	nonce: string
	exp: number
	host: string
	pkg: string
	kid: string
	src: string
	commit: string | null
	binding: string
}

const liveNonces = new Map<string, number>()
const burnedNonces = new Map<string, number>()
const signingKeys = new Map<string, Promise<CryptoKey>>()
let localSigningSecret: string | null = null

export class PackageAppVisitTicketError extends Error {
	constructor() {
		super('Package app visit ticket is not valid.')
		this.name = 'PackageAppVisitTicketError'
	}
}

function localSigningSecretForTests() {
	if (!localSigningSecret) {
		const bytes = new Uint8Array(32)
		crypto.getRandomValues(bytes)
		localSigningSecret = toHex(bytes)
	}
	return localSigningSecret
}

function signingSecret(secretStoreKey: string | undefined) {
	const key = secretStoreKey?.trim() ?? ''
	if (key.length >= 32) return key
	// Local and unit tests have no usable server key. Tickets minted here
	// only verify on this isolate, which is enough for those environments.
	return localSigningSecretForTests()
}

function derivationKey(secretStoreKey: string | undefined) {
	const secret = signingSecret(secretStoreKey)
	let key = signingKeys.get(secret)
	if (!key) {
		key = (async () => {
			const base = await crypto.subtle.importKey(
				'raw',
				new TextEncoder().encode(secret),
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
		key.catch(() => {
			signingKeys.delete(secret)
		})
		signingKeys.set(secret, key)
	}
	return key
}

function pruneNonceMaps(now: number) {
	for (const [nonce, until] of burnedNonces) {
		if (until <= now) burnedNonces.delete(nonce)
	}
	for (const [nonce, until] of liveNonces) {
		if (until <= now) liveNonces.delete(nonce)
	}
}

const isText = (field: unknown) => typeof field === 'string'
const isNonEmptyText = (field: unknown) =>
	typeof field === 'string' && field.trim().length > 0
const isFiniteNumber = (field: unknown) =>
	typeof field === 'number' && Number.isFinite(field)

function isStoredAnonymousVisitTicket(
	value: unknown,
): value is StoredAnonymousVisitTicket {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		record.v === 1 &&
		record.anon === true &&
		isNonEmptyText(record.nonce) &&
		isFiniteNumber(record.exp) &&
		isText(record.host) &&
		isNonEmptyText(record.pkg) &&
		isText(record.kid) &&
		isText(record.src) &&
		(record.commit === null || isText(record.commit)) &&
		isNonEmptyText(record.binding)
	)
}

function isStoredVisitTicket(value: unknown): value is StoredVisitTicket {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		record.v === 1 &&
		isNonEmptyText(record.nonce) &&
		isFiniteNumber(record.exp) &&
		isText(record.host) &&
		isNonEmptyText(record.pkg) &&
		isText(record.kid) &&
		isText(record.src) &&
		(record.commit === null || isText(record.commit)) &&
		isNonEmptyText(record.oid) &&
		(record.ou === null || isText(record.ou)) &&
		isText(record.oe) &&
		isText(record.od) &&
		isNonEmptyText(record.sub) &&
		isText(record.vu) &&
		(record.role === null || orgRoles.includes(record.role as OrgRole)) &&
		isNonEmptyText(record.binding) &&
		(record.grantId === null || isText(record.grantId)) &&
		Array.isArray(record.scopes) &&
		record.scopes.every((scope) => typeof scope === 'string') &&
		(record.cs === undefined ||
			record.cs === null ||
			(Array.isArray(record.cs) && record.cs.every(isOrgPermission))) &&
		(record.cp === undefined || record.cp === null || isText(record.cp)) &&
		(record.cpi === undefined || record.cpi === null || isText(record.cpi)) &&
		(record.cpc === undefined ||
			record.cpc === null ||
			(Array.isArray(record.cpc) && record.cpc.every(isNonEmptyText))) &&
		(record.xo === undefined || record.xo === true) &&
		(record.bo === undefined || isNonEmptyText(record.bo))
	)
}

function claimsFromStored(stored: StoredVisitTicket): PackageAppVisitClaims {
	return {
		visitor: {
			userId: personIdFromStored(stored.sub),
			username: stored.vu,
			role: stored.role,
		},
		owner: {
			userId: ownerIdFromStored(stored.oid),
			orgSlug: stored.ou,
			email: stored.oe,
			displayName: stored.od,
		},
		audience: {
			host: stored.host,
			packageId: stored.pkg,
			kodyId: stored.kid,
			sourceId: stored.src,
			publishedCommit: stored.commit,
		},
		nonce: stored.nonce,
		credentialClientBinding: stored.binding,
		grantId: stored.grantId,
		scopes: stored.scopes,
		credentialScopes: (stored.cs as Array<OrgPermission> | undefined) ?? null,
		credentialProfileId: stored.cpi ?? null,
		...(stored.cpi && stored.cpc?.at(-1) === stored.cpi
			? { credentialProfileChain: stored.cpc }
			: {}),
		...(stored.xo ? { executorOnly: true } : {}),
		...(stored.bo ? { billing: { orgId: ownerIdFromStored(stored.bo) } } : {}),
		exp: stored.exp,
	}
}

function anonymousClaimsFromStored(
	stored: StoredAnonymousVisitTicket,
): PackageAppAnonymousVisitClaims {
	return {
		visitor: null,
		audience: {
			host: stored.host,
			packageId: stored.pkg,
			kodyId: stored.kid,
			sourceId: stored.src,
			publishedCommit: stored.commit,
		},
		nonce: stored.nonce,
		credentialClientBinding: stored.binding,
		exp: stored.exp,
	}
}

async function signTicket(input: {
	env: Pick<Env, 'SECRET_STORE_KEY'>
	purpose: string
	prefix: string
	stored: StoredVisitTicket | StoredAnonymousVisitTicket
}) {
	const payload = utf8ToBase64Url(JSON.stringify(input.stored))
	const signature = await crypto.subtle.sign(
		'HMAC',
		await derivationKey(input.env.SECRET_STORE_KEY),
		new TextEncoder().encode(`${input.purpose}.${payload}`),
	)
	return `${input.prefix}${payload}.${bytesToBase64Url(new Uint8Array(signature))}`
}

function assertTicketBinding(binding: string) {
	if (!binding.trim()) {
		throw new Error('A package app visit needs a credential client binding.')
	}
}

function audienceMatches(
	expected: PackageAppVisitAudience,
	actual: PackageAppVisitAudience,
) {
	return (
		expected.host === actual.host &&
		expected.packageId === actual.packageId &&
		expected.kodyId === actual.kodyId &&
		expected.sourceId === actual.sourceId &&
		expected.publishedCommit === actual.publishedCommit
	)
}

/** Clears the nonce registry so tests can mint and replay in isolation. */
export function resetPackageAppVisitNoncesForTests() {
	liveNonces.clear()
	burnedNonces.clear()
	localSigningSecret = null
	signingKeys.clear()
}

/** Mark a visit nonce live for this request. Mint already does this. */
export function beginPackageAppVisit(nonce: string, now = Date.now()) {
	pruneNonceMaps(now)
	liveNonces.set(nonce, now + packageAppVisitLiveHoldMs)
}

/**
 * End-of-request revocation on this host isolate. Later verify of the same
 * nonce is a replay and is refused.
 */
export function endPackageAppVisit(nonce: string | null | undefined) {
	if (!nonce) return
	liveNonces.delete(nonce)
	burnedNonces.set(nonce, Date.now() + packageAppVisitTicketTtlMs)
}

/** Drop the live mark without burning, as if verify ran on another isolate. */
export function forgetPackageAppVisitLiveForTests(nonce: string) {
	liveNonces.delete(nonce)
}

/**
 * Burn the nonce when the returned body completes, cancels, or cannot be
 * watched. Header resolve is not the end of the visit: streamed bodies and
 * waitUntil work still need the ticket.
 */
export function endPackageAppVisitWithResponse(
	response: Response,
	nonce: string | null | undefined,
) {
	if (!nonce) return response
	const webSocket = 'webSocket' in response ? response.webSocket : null
	if (webSocket || response.status === 101) {
		endPackageAppVisit(nonce)
		return response
	}
	const body = response.body
	if (!body) {
		endPackageAppVisit(nonce)
		return response
	}
	try {
		const reader = body.getReader()
		let settled = false
		const settle = () => {
			if (settled) return
			settled = true
			endPackageAppVisit(nonce)
		}
		const watched = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { done, value } = await reader.read()
					if (done) {
						settle()
						controller.close()
						return
					}
					controller.enqueue(value)
				} catch (error) {
					settle()
					controller.error(error)
				}
			},
			async cancel(reason) {
				settle()
				await reader.cancel(reason)
			},
		})
		return new Response(watched, response)
	} catch {
		endPackageAppVisit(nonce)
		return response
	}
}

export async function mintPackageAppVisitTicket(input: {
	env: Pick<Env, 'SECRET_STORE_KEY'>
	visitor: RuntimePackageAppVisitor
	owner: PackageAppVisitClaims['owner']
	audience: PackageAppVisitAudience
	credentialClientBinding: string
	grantId?: string | null
	scopes?: ReadonlyArray<string>
	credential?: Pick<
		RequestCredential,
		'scopes' | 'profileId' | 'profileChain'
	> | null
	executorOnly?: boolean
	billing?: RequestBilling | null
	nonce?: string
	now?: number
}): Promise<{ ticket: string; nonce: string; exp: number }> {
	assertTicketBinding(input.credentialClientBinding)
	const now = input.now ?? Date.now()
	const nonce = input.nonce ?? crypto.randomUUID()
	const exp = now + packageAppVisitTicketTtlMs
	const ticket = await signTicket({
		env: input.env,
		purpose: ticketPurpose,
		prefix: packageAppVisitTicketPrefix,
		stored: {
			v: 1,
			nonce,
			exp,
			host: input.audience.host,
			pkg: input.audience.packageId,
			kid: input.audience.kodyId,
			src: input.audience.sourceId,
			commit: input.audience.publishedCommit,
			oid: input.owner.userId,
			ou: input.owner.orgSlug,
			oe: input.owner.email,
			od: input.owner.displayName,
			sub: input.visitor.userId,
			vu: input.visitor.username,
			role: input.visitor.role,
			binding: input.credentialClientBinding,
			grantId: input.grantId ?? null,
			scopes: [...(input.scopes ?? [])],
			cs: input.credential?.scopes ? [...input.credential.scopes] : null,
			...(input.credential?.profileId
				? {
						cpi: input.credential.profileId,
						...(input.credential.profileChain?.length
							? { cpc: [...input.credential.profileChain] }
							: {}),
					}
				: {}),
			...(input.executorOnly ? { xo: true as const } : {}),
			...(input.billing ? { bo: input.billing.orgId } : {}),
		},
	})
	beginPackageAppVisit(nonce, now)
	return { ticket, nonce, exp }
}

/**
 * Mint the ticket for a request with no acting visitor. It names nobody and
 * carries only the request's credential-client binding.
 */
export async function mintPackageAppAnonymousVisitTicket(input: {
	env: Pick<Env, 'SECRET_STORE_KEY'>
	audience: PackageAppVisitAudience
	credentialClientBinding: string
	nonce?: string
	now?: number
}): Promise<{ ticket: string; nonce: string; exp: number }> {
	assertTicketBinding(input.credentialClientBinding)
	const now = input.now ?? Date.now()
	const nonce = input.nonce ?? crypto.randomUUID()
	const exp = now + packageAppVisitTicketTtlMs
	const ticket = await signTicket({
		env: input.env,
		purpose: anonymousTicketPurpose,
		prefix: packageAppAnonymousVisitTicketPrefix,
		stored: {
			v: 1,
			anon: true,
			nonce,
			exp,
			host: input.audience.host,
			pkg: input.audience.packageId,
			kid: input.audience.kodyId,
			src: input.audience.sourceId,
			commit: input.audience.publishedCommit,
			binding: input.credentialClientBinding,
		},
	})
	beginPackageAppVisit(nonce, now)
	return { ticket, nonce, exp }
}

export async function verifyPackageAppVisitTicket(input: {
	env: Pick<Env, 'SECRET_STORE_KEY'>
	ticket: string
	audience: PackageAppVisitAudience
	now?: number
}): Promise<PackageAppVerifiedVisit> {
	const fail = () => new PackageAppVisitTicketError()
	const ticket = input.ticket.trim()
	const anonymous = ticket.startsWith(packageAppAnonymousVisitTicketPrefix)
	if (!anonymous && !ticket.startsWith(packageAppVisitTicketPrefix)) {
		throw fail()
	}
	const prefix = anonymous
		? packageAppAnonymousVisitTicketPrefix
		: packageAppVisitTicketPrefix
	const purpose = anonymous ? anonymousTicketPurpose : ticketPurpose
	const [payload, signature, extra] = ticket.slice(prefix.length).split('.')
	if (!payload || !signature || extra !== undefined) throw fail()
	let valid = false
	try {
		valid = await crypto.subtle.verify(
			'HMAC',
			await derivationKey(input.env.SECRET_STORE_KEY),
			base64UrlToBytes(signature),
			new TextEncoder().encode(`${purpose}.${payload}`),
		)
	} catch {
		throw fail()
	}
	if (!valid) throw fail()
	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)))
	} catch {
		throw fail()
	}
	if (
		anonymous
			? !isStoredAnonymousVisitTicket(parsed)
			: !isStoredVisitTicket(parsed)
	) {
		throw fail()
	}
	const stored = parsed as StoredVisitTicket | StoredAnonymousVisitTicket
	const now = input.now ?? Date.now()
	pruneNonceMaps(now)
	const liveUntil = liveNonces.get(stored.nonce) ?? 0
	if (
		(stored.exp <= now && liveUntil <= now) ||
		stored.exp > now + packageAppVisitTicketTtlMs ||
		burnedNonces.has(stored.nonce) ||
		!audienceMatches(input.audience, {
			host: stored.host,
			packageId: stored.pkg,
			kodyId: stored.kid,
			sourceId: stored.src,
			publishedCommit: stored.commit,
		})
	) {
		throw fail()
	}
	return 'anon' in stored
		? anonymousClaimsFromStored(stored)
		: claimsFromStored(stored)
}

/** Read and verify the platform-set visit ticket on a package-code request. */
export async function verifyPackageAppVisitTicketFromRequest(input: {
	env: Pick<Env, 'SECRET_STORE_KEY'>
	request: Request
	audience: PackageAppVisitAudience
	now?: number
}): Promise<PackageAppVerifiedVisit | null> {
	const ticket = input.request.headers.get(packageAppVisitTicketHeaderName)
	if (!ticket) return null
	return await verifyPackageAppVisitTicket({
		env: input.env,
		ticket,
		audience: input.audience,
		now: input.now,
	})
}

/** Set (or clear) the visit ticket on a request bound for package code. */
export function withPackageAppVisitTicket(
	request: Request,
	ticket: string | null | undefined,
) {
	const next = new Request(request)
	next.headers.delete(packageAppVisitTicketHeaderName)
	if (ticket) next.headers.set(packageAppVisitTicketHeaderName, ticket)
	return next
}

/** Rebuild the request context a verified ticket authorizes. */
export function requestContextFromVisitClaims(
	claims: PackageAppVisitClaims,
): RequestContext {
	return {
		org: {
			id: claims.owner.userId,
			slug: claims.owner.orgSlug,
		},
		actor: {
			userId: claims.visitor.userId,
			username: claims.visitor.username,
		},
		attribution: { kind: 'user', userId: claims.visitor.userId },
		credential: {
			kind: 'package-app',
			id: null,
			orgId: claims.owner.userId,
			scopes: claims.credentialScopes ?? null,
			...(claims.credentialProfileId
				? {
						profileId: claims.credentialProfileId,
						...(claims.credentialProfileChain?.length
							? { profileChain: [...claims.credentialProfileChain] }
							: {}),
					}
				: {}),
		},
		membership: claims.visitor.role ? { role: claims.visitor.role } : null,
		...(claims.billing ? { billing: claims.billing } : {}),
	}
}

export async function createPackageAppRequestVisit(input: {
	env: Pick<Env, 'SECRET_STORE_KEY'>
	visitor: RuntimePackageAppVisitor | null
	owner: PackageAppVisitClaims['owner']
	audience: PackageAppVisitAudience
	request: RequestContext | null
	grantId?: string | null
	scopes?: ReadonlyArray<string>
	/**
	 * An outside-org visitor with a live grant for this app's executor needs.
	 * Only used when there is no `visitor`: the ticket names them for
	 * `credential.visitor()` and nothing else.
	 */
	executorVisitor?: RuntimePackageAppVisitor | null
	now?: number
}): Promise<PackageAppRequestVisit> {
	const credentialClientBinding = newRunCredentialClientBinding()
	if (!input.visitor && input.executorVisitor) {
		const executorVisitor = { ...input.executorVisitor, role: null }
		const minted = await mintPackageAppVisitTicket({
			env: input.env,
			visitor: executorVisitor,
			owner: input.owner,
			audience: input.audience,
			credentialClientBinding,
			grantId: input.grantId,
			scopes: input.scopes,
			executorOnly: true,
			now: input.now,
		})
		return {
			ticket: minted.ticket,
			nonce: minted.nonce,
			visitor: null,
			request: null,
			credentialClientBinding,
			email: input.owner.email,
			displayName: input.owner.displayName,
			claims: {
				visitor: executorVisitor,
				owner: input.owner,
				audience: input.audience,
				nonce: minted.nonce,
				credentialClientBinding,
				grantId: input.grantId ?? null,
				scopes: [...(input.scopes ?? [])],
				executorOnly: true,
				exp: minted.exp,
			},
		}
	}
	if (!input.visitor || !input.request?.actor) {
		const minted = await mintPackageAppAnonymousVisitTicket({
			env: input.env,
			audience: input.audience,
			credentialClientBinding,
			now: input.now,
		})
		return {
			ticket: minted.ticket,
			nonce: minted.nonce,
			visitor: null,
			request: null,
			credentialClientBinding,
			email: input.owner.email,
			displayName: input.owner.displayName,
			claims: null,
		}
	}
	const billing = input.request.billing ?? null
	const minted = await mintPackageAppVisitTicket({
		env: input.env,
		visitor: input.visitor,
		owner: input.owner,
		audience: input.audience,
		credentialClientBinding,
		grantId: input.grantId,
		scopes: input.scopes,
		credential: input.request.credential,
		billing,
		now: input.now,
	})
	const claims: PackageAppVisitClaims = {
		visitor: input.visitor,
		owner: input.owner,
		audience: input.audience,
		nonce: minted.nonce,
		credentialClientBinding,
		grantId: input.grantId ?? null,
		scopes: [...(input.scopes ?? [])],
		credentialScopes: input.request.credential.scopes,
		credentialProfileId: input.request.credential.profileId ?? null,
		credentialProfileChain: input.request.credential.profileChain ?? null,
		...(billing ? { billing } : {}),
		exp: minted.exp,
	}
	return {
		ticket: minted.ticket,
		nonce: minted.nonce,
		visitor: input.visitor,
		request: input.request,
		credentialClientBinding,
		email: input.owner.email,
		displayName: input.owner.displayName,
		claims,
	}
}
