import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { normalizeEmailAddress, splitEmailLocalPart } from './address.ts'
import { isPermanentlyReservedUsername } from '#worker/identity/reserved-usernames.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/**
 * The label prepended to the app hostname to form the default user email
 * domain (`inbox.kody.codes` for `APP_BASE_URL` `https://kody.codes`).
 */
export const defaultUserEmailSubdomainLabel = 'inbox'

const bareHostnamePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

/**
 * The email domain operator-owned system mail lives on: the
 * `SYSTEM_EMAIL_DOMAIN` env var when set, otherwise the hostname of
 * `APP_BASE_URL`. The transactional sender (`kody@<domain>`) and the
 * operator system inboxes both use this domain, keeping them structurally
 * separate from the user subdomain.
 *
 * The override decouples email from the web origin so the two can move
 * independently: production pins the committed value, inbound also accepts
 * `LEGACY_SYSTEM_EMAIL_DOMAINS`, and outbound always sends from the
 * canonical domain.
 */
export function getSystemEmailDomain(env: {
	APP_BASE_URL?: string | null
	SYSTEM_EMAIL_DOMAIN?: string | null
}): string | null {
	const configuredDomain = env.SYSTEM_EMAIL_DOMAIN?.trim()
		.toLowerCase()
		.replace(/\.$/, '')
	if (configuredDomain && bareHostnamePattern.test(configuredDomain)) {
		return configuredDomain
	}
	// Runtime env validation should already catch a malformed override; fall
	// back to the derived default defensively (same as getPlatformEmailDomain).
	const configuredBaseUrl = env.APP_BASE_URL?.trim()
	if (!configuredBaseUrl) return null
	try {
		const hostname = new URL(configuredBaseUrl).hostname.toLowerCase()
		return hostname.length > 0 ? hostname : null
	} catch {
		return null
	}
}

/**
 * The email domain every user inbox and user outbound sender lives on: the
 * `USER_EMAIL_DOMAIN` env var when set, otherwise `inbox.` plus the
 * hostname of `APP_BASE_URL` (for example `inbox.kody.codes`).
 *
 * User mail deliberately lives on a dedicated subdomain, not the apex: the
 * user-controlled address namespace stays structurally separate from system
 * mail on the apex (the `kody@<apex>` transactional sender and the operator
 * system inboxes), and user outbound sender reputation (SPF/DKIM/DMARC) is
 * isolated from the system sender's.
 *
 * Returns null when nothing is configured, in which case user email
 * addressing is unavailable.
 */
export function getPlatformEmailDomain(env: {
	APP_BASE_URL?: string | null
	USER_EMAIL_DOMAIN?: string | null
}): string | null {
	const configuredDomain = env.USER_EMAIL_DOMAIN?.trim()
		.toLowerCase()
		.replace(/\.$/, '')
	if (configuredDomain && bareHostnamePattern.test(configuredDomain)) {
		return configuredDomain
	}
	// Runtime env validation should already catch a malformed override; fall
	// back to the derived default defensively (same as getAppBaseUrl).
	const configuredBaseUrl = env.APP_BASE_URL?.trim()
	if (!configuredBaseUrl) return null
	try {
		const hostname = new URL(configuredBaseUrl).hostname.toLowerCase()
		return hostname.length > 0
			? `${defaultUserEmailSubdomainLabel}.${hostname}`
			: null
	} catch {
		return null
	}
}

function parseEmailDomainList(configured: string | null | undefined) {
	if (!configured) return []
	const domains: Array<string> = []
	for (const entry of configured.split(',')) {
		const domain = entry.trim().toLowerCase().replace(/\.$/, '')
		if (!domain || !bareHostnamePattern.test(domain)) continue
		if (!domains.includes(domain)) domains.push(domain)
	}
	return domains
}

/**
 * Every domain inbound user mail is accepted on: the canonical platform
 * domain first, then `LEGACY_USER_EMAIL_DOMAINS` (comma-separated). Mail to
 * any listed domain resolves to the same user inbox.
 */
export function getAcceptedUserEmailDomains(env: {
	APP_BASE_URL?: string | null
	USER_EMAIL_DOMAIN?: string | null
	LEGACY_USER_EMAIL_DOMAINS?: string | null
}): Array<string> {
	const canonical = getPlatformEmailDomain(env)
	const domains = canonical ? [canonical] : []
	for (const domain of parseEmailDomainList(env.LEGACY_USER_EMAIL_DOMAINS)) {
		if (!domains.includes(domain)) domains.push(domain)
	}
	return domains
}

/**
 * Every domain inbound system mail is accepted on: the canonical system
 * domain first, then `LEGACY_SYSTEM_EMAIL_DOMAINS` (comma-separated).
 * Operator inboxes (`kody@`, `support@`, ...) accept mail on every listed
 * apex.
 */
export function getAcceptedSystemEmailDomains(env: {
	APP_BASE_URL?: string | null
	SYSTEM_EMAIL_DOMAIN?: string | null
	LEGACY_SYSTEM_EMAIL_DOMAINS?: string | null
}): Array<string> {
	const canonical = getSystemEmailDomain(env)
	const domains = canonical ? [canonical] : []
	for (const domain of parseEmailDomainList(env.LEGACY_SYSTEM_EMAIL_DOMAINS)) {
		if (!domains.includes(domain)) domains.push(domain)
	}
	return domains
}

export function buildPlatformEmailAddress(input: {
	username: string
	domain: string
}) {
	return `${input.username.trim().toLowerCase()}@${input.domain}`
}

async function findUserAccount(input: {
	db: D1Database
	accountEmail: string | null | undefined
	userId: string
}): Promise<{ email: string; username: string | null } | null> {
	const userId = input.userId.trim()
	if (!userId) return null
	// The stored stable userId is the authoritative identity: a caller-supplied
	// email is only trusted (as an indexed lookup) when it matches that
	// `users.stable_user_id`, so a mismatched pair can never yield another
	// account's platform sender address.
	const email = normalizeEmail(input.accountEmail ?? '')
	if (email) {
		const row = await input.db
			.prepare(
				`SELECT email, stable_user_id, username
				 FROM users
				 WHERE email = ? AND stable_user_id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(email, userId)
			.first<{
				email: string
				stable_user_id: string
				username: string | null
			}>()
		if (row && row.stable_user_id.trim() === userId) {
			return {
				email: row.email,
				username: row.username?.trim().toLowerCase() || null,
			}
		}
		// Caller email did not match this stable id; ignore it and resolve by
		// the authoritative indexed stable id below.
	}
	// Package runtime contexts (for example email subscription handlers) act
	// with the stable userId but no account email; resolve the account the
	// same way isAccountEmailVerified does.
	const row = await input.db
		.prepare(
			`SELECT email, username
			 FROM users
			 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(userId)
		.first<{
			email: string
			username: string | null
		}>()
	if (row) {
		return {
			email: normalizeEmail(row.email),
			username: row.username?.trim().toLowerCase() || null,
		}
	}
	return null
}

export type ResolvedPlatformSender = {
	/** Platform-assigned from address: {username}@<platform domain>. */
	from: string
	/**
	 * The account email backing the acting userId, resolved even when the
	 * caller context carried none, so plan/entitlement lookups always bind.
	 */
	accountEmail: string
	username: string
	domain: string
}

/**
 * Resolve the platform-assigned outbound sender (`{username}@<platform
 * domain>`) and the backing account email for the acting user. The from
 * address is never caller-supplied: it always derives from the account's
 * username, and permanently reserved local parts (including `kody@`, the
 * transactional system sender) can never send user mail. Other reserved
 * names may be unreserved and claimed; a live account may send.
 */
export async function resolveUserPlatformSender(input: {
	db: D1Database
	env: { APP_BASE_URL?: string | null }
	accountEmail: string | null | undefined
	userId: string
}): Promise<ResolvedPlatformSender> {
	const domain = getPlatformEmailDomain(input.env)
	if (!domain) {
		throw new Error(
			'Outbound email is unavailable because no platform email domain is configured.',
		)
	}
	const account = await findUserAccount(input)
	if (!account) {
		throw new Error('A signed-in account email is required to send email.')
	}
	if (!account.username) {
		throw new Error('No account username found for outbound email.')
	}
	if (isPermanentlyReservedUsername(account.username)) {
		throw new Error(
			'Reserved usernames cannot send email; they are limited to system mail.',
		)
	}
	return {
		from: buildPlatformEmailAddress({ username: account.username, domain }),
		accountEmail: account.email,
		username: account.username,
		domain,
	}
}

const senderAliasTagPattern = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/
const maxEmailLocalPartLength = 64

/**
 * The canonical sender address for `address` when it is the sender's own
 * platform address or an RFC 5233 plus alias of it (`{username}+{tag}@`)
 * on an accepted user email domain. Legacy domains map to the canonical
 * domain. Returns null for anything the sender does not own: another
 * handle, another domain, an empty or malformed tag.
 */
export function resolveOwnedSenderAddress(input: {
	address: string
	sender: Pick<ResolvedPlatformSender, 'username' | 'domain'>
	acceptedDomains: ReadonlyArray<string>
}): string | null {
	const normalized = normalizeEmailAddress(input.address)
	if (!normalized) return null
	const atIndex = normalized.lastIndexOf('@')
	const localPart = normalized.slice(0, atIndex)
	const domain = normalized.slice(atIndex + 1)
	if (domain !== input.sender.domain && !input.acceptedDomains.includes(domain))
		return null
	const { base, subaddress } = splitEmailLocalPart(localPart)
	if (base !== input.sender.username) return null
	if (localPart === base) {
		return buildPlatformEmailAddress({
			username: input.sender.username,
			domain: input.sender.domain,
		})
	}
	if (
		!subaddress ||
		localPart.length > maxEmailLocalPartLength ||
		!senderAliasTagPattern.test(subaddress)
	) {
		return null
	}
	return `${input.sender.username}+${subaddress}@${input.sender.domain}`
}
