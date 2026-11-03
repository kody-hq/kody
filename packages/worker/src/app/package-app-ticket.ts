import {
	base64UrlToBytes,
	bytesToBase64Url,
	utf8ToBase64Url,
} from '@kody-internal/shared/base64.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { OrgRole } from '@kody-internal/shared/request-context.ts'
import type { RuntimePackageAppVisitor } from '@kody-internal/shared/runtime-worker.ts'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import type { PackageAppServeOwner } from '#worker/package-runtime/package-app-serve.ts'

/**
 * Short-lived signed access ticket for one visitor on one package app.
 *
 * After one full access check, the package-app origin mints this ticket as a
 * host-only cookie. While it is valid, requests for that app are authorized
 * by verifying its HMAC signature alone: no storage read. It carries what
 * serving needs (org owner, visitor role) plus the org `access_epoch` it was
 * minted at, so the refresh after expiry can reuse a cached decision only
 * when the epoch has not moved.
 *
 * Bound to the host, the app slug, the visitor, and the `kody_pkg_session`
 * it was minted under, so it cannot be replayed on another host, for another
 * app, or after the session is replaced.
 *
 * Signing keys come from `PACKAGE_APP_TICKET_KEYS` (comma-separated). Every
 * key verifies; the first one signs. Rotate by prepending a new key, waiting
 * at least one ticket lifetime, then dropping the old key
 * (docs/contributing/secret-rotation.md). Without the secret, one key is
 * derived from `COOKIE_SECRET` under a purpose label.
 */

export const packageAppTicketTtlMs = 90_000
const ticketPurpose = 'kody-package-app-ticket:v1'
const secureTicketCookiePrefix = '__Host-kody_pkg_ticket_'
const insecureTicketCookiePrefix = 'kody_pkg_ticket_'

export type PackageAppTicketGrant = {
	owner: PackageAppServeOwner
	visitor: RuntimePackageAppVisitor
	/** Org `access_epoch` the grant was decided at. */
	epoch: number
}

type StoredTicket = {
	v: 1
	/** Visitor person id. */
	sub: string
	/** `issuedAt` of the `kody_pkg_session` the ticket was minted under. */
	sat: number
	host: string
	/** App slug, lowercased. */
	app: string
	exp: number
	ep: number
	role: OrgRole | null
	vu: string
	oid: string
	ou: string
	od: string
	oe: string
}

const orgRoles: ReadonlyArray<OrgRole> = ['owner', 'member', 'billing']

export function parsePackageAppTicketKeys(raw: string | undefined) {
	return (raw ?? '')
		.split(',')
		.map((key) => key.trim())
		.filter((key) => key.length > 0)
}

let cachedKeys: { source: string; keys: Array<CryptoKey> } | null = null

async function getTicketKeys(env: Env) {
	const configured = parsePackageAppTicketKeys(env.PACKAGE_APP_TICKET_KEYS)
	let sources = configured
	if (sources.length === 0) {
		const cookieSecret = env.COOKIE_SECRET?.trim()
		if (!cookieSecret) {
			throw new Error(
				'Missing PACKAGE_APP_TICKET_KEYS and COOKIE_SECRET for package app ticket signing.',
			)
		}
		sources = [cookieSecret]
	}
	const source = sources.join('\n')
	if (cachedKeys?.source === source) return cachedKeys.keys
	const keys = await Promise.all(
		sources.map((secret) =>
			crypto.subtle.importKey(
				'raw',
				new TextEncoder().encode(`${ticketPurpose}:${secret}`),
				{ name: 'HMAC', hash: 'SHA-256' },
				false,
				['sign', 'verify'],
			),
		),
	)
	cachedKeys = { source, keys }
	return keys
}

/** Clears the imported key cache so tests can swap secrets. */
export function resetPackageAppTicketKeysForTests() {
	cachedKeys = null
}

async function ticketCookieName(slug: string, secure: boolean) {
	const appTag = (await sha256Base64Url(slug.trim().toLowerCase())).slice(0, 12)
	return `${secure ? secureTicketCookiePrefix : insecureTicketCookiePrefix}${appTag}`
}

function readCookie(header: string, name: string) {
	for (const part of header.split(';')) {
		const separator = part.indexOf('=')
		if (separator < 0) continue
		if (part.slice(0, separator).trim() === name) {
			return part.slice(separator + 1).trim()
		}
	}
	return null
}

function signedMessage(payload: string) {
	return new TextEncoder().encode(`${ticketPurpose}.${payload}`)
}

function isStoredTicket(value: unknown): value is StoredTicket {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	const isText = (field: unknown) => typeof field === 'string'
	const isNonEmptyText = (field: unknown) =>
		typeof field === 'string' && field.trim().length > 0
	const isFiniteNumber = (field: unknown) =>
		typeof field === 'number' && Number.isFinite(field)
	return (
		record.v === 1 &&
		isNonEmptyText(record.sub) &&
		isNonEmptyText(record.oid) &&
		isFiniteNumber(record.sat) &&
		isText(record.host) &&
		isText(record.app) &&
		isFiniteNumber(record.exp) &&
		isFiniteNumber(record.ep) &&
		(record.role === null || orgRoles.includes(record.role as OrgRole)) &&
		isText(record.vu) &&
		isText(record.ou) &&
		isText(record.od) &&
		isText(record.oe)
	)
}

/** Clears the host-only ticket cookie for `slug`. */
export async function destroyPackageAppTicketCookie(input: {
	env: Env
	slug: string
	secure: boolean
}) {
	const name = await ticketCookieName(input.slug, input.secure)
	return [
		`${name}=`,
		'Path=/',
		'Max-Age=0',
		'HttpOnly',
		'SameSite=Lax',
		'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
		...(input.secure ? ['Secure'] : []),
	].join('; ')
}

/** `Set-Cookie` value for a fresh ticket on `host` for app `slug`. */
export async function mintPackageAppTicketCookie(input: {
	env: Env
	host: string
	slug: string
	sessionIssuedAt: number
	grant: PackageAppTicketGrant
	secure: boolean
	now?: number
}) {
	const now = input.now ?? Date.now()
	const { owner, visitor, epoch } = input.grant
	const payload = utf8ToBase64Url(
		JSON.stringify({
			v: 1,
			sub: visitor.userId,
			sat: input.sessionIssuedAt,
			host: input.host,
			app: input.slug.trim().toLowerCase(),
			exp: now + packageAppTicketTtlMs,
			ep: epoch,
			role: visitor.role,
			vu: visitor.username,
			oid: owner.userId,
			ou: owner.username,
			od: owner.displayName,
			oe: owner.email,
		} satisfies StoredTicket),
	)
	const [signingKey] = await getTicketKeys(input.env)
	if (!signingKey) throw new Error('No package app ticket signing key.')
	const signature = await crypto.subtle.sign(
		'HMAC',
		signingKey,
		signedMessage(payload),
	)
	const name = await ticketCookieName(input.slug, input.secure)
	const value = `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`
	return [
		`${name}=${value}`,
		'Path=/',
		`Max-Age=${Math.floor(packageAppTicketTtlMs / 1000)}`,
		'HttpOnly',
		'SameSite=Lax',
		...(input.secure ? ['Secure'] : []),
	].join('; ')
}

/**
 * The grant carried by a valid ticket for this host, app, and session, or
 * null when there is none, it is expired, or anything fails to verify.
 * Pure CPU: signature verification only.
 */
export async function readPackageAppTicket(input: {
	request: Request
	env: Env
	host: string
	slug: string
	session: { stableUserId: string; issuedAt: number }
	secure: boolean
	now?: number
}): Promise<PackageAppTicketGrant | null> {
	const cookieHeader = input.request.headers.get('Cookie')
	if (!cookieHeader) return null
	const token = readCookie(
		cookieHeader,
		await ticketCookieName(input.slug, input.secure),
	)
	if (!token) return null
	const [payload, signature, ...rest] = token.split('.')
	if (!payload || !signature || rest.length > 0) return null

	let signatureBytes: ReturnType<typeof base64UrlToBytes>
	try {
		signatureBytes = base64UrlToBytes(signature)
	} catch {
		return null
	}
	const message = signedMessage(payload)
	let verified = false
	for (const key of await getTicketKeys(input.env)) {
		if (await crypto.subtle.verify('HMAC', key, signatureBytes, message)) {
			verified = true
			break
		}
	}
	if (!verified) return null

	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)))
	} catch {
		return null
	}
	if (!isStoredTicket(parsed)) return null
	const now = input.now ?? Date.now()
	if (
		parsed.exp <= now ||
		parsed.exp > now + packageAppTicketTtlMs ||
		parsed.sub !== input.session.stableUserId ||
		parsed.sat !== input.session.issuedAt ||
		parsed.host !== input.host ||
		parsed.app !== input.slug.trim().toLowerCase()
	) {
		return null
	}
	return {
		owner: {
			userId: ownerIdFromStored(parsed.oid),
			username: parsed.ou,
			displayName: parsed.od,
			email: parsed.oe,
		},
		visitor: {
			userId: personIdFromStored(parsed.sub),
			username: parsed.vu,
			role: parsed.role,
		},
		epoch: parsed.ep,
	}
}
