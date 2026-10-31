import { type SecretScope } from '#mcp/secrets/types.ts'

const secretPlaceholderRegex =
	/\{\{secret:([a-zA-Z0-9._-]+)(?:\|scope=(session|package|user))?(?:\|ref=([A-Za-z0-9_-]+))?\}\}/g
const providerSecretPlaceholderRegex =
	/\{\{secret\/([a-zA-Z0-9._-]+):([^}]+)\}\}/g
const basicAuthSecretPlaceholderRegex =
	/\{\{secret-basic:username=([a-zA-Z0-9._-]+),password=([a-zA-Z0-9._-]+)(?:\|scope=(session|package|user))?\}\}/g
const integrationTokenPlaceholderRegex =
	/\{\{integration-token:([a-zA-Z0-9._-]+)\}\}/g

/**
 * Documentation / example placeholders are display text: the fetch gateway
 * never fills them, and stamp / inventory scans do not count them as
 * credential uses. Two inert forms:
 * - Angle-bracket markers: `{{secret/<provider>:<ref>}}`,
 *   `{{secret/bwvault:i/<item-uuid>/<field>}}`
 * - Grammar metavariables only: provider id is the literal `provider` and
 *   every ref path segment is a docs metavariable (`ref`, `field`, …), as in
 *   the platform copy `{{secret/provider:ref}}`
 */
const examplePlaceholderMarkerPattern = /<[^>]+>/
/** Structural item-form prefix; not a concrete id by itself. */
const vaultItemFormPrefix = 'i'
const vaultGrammarMetavariables = new Set([
	'provider',
	'ref',
	'field',
	'item',
	'item-id',
	'item-uuid',
	'name',
	'vault',
])

export function placeholderHoldsExampleMarkers(token: string) {
	// URL path serialization may leave `<` / `>` as %3C / %3E even after
	// placeholder-punctuation decode (which only restores { } : / = , |).
	const withAngleBrackets = token
		.replaceAll(/%3C/gi, '<')
		.replaceAll(/%3E/gi, '>')
	return examplePlaceholderMarkerPattern.test(withAngleBrackets)
}

/**
 * True when a matched `{{secret/…}}` token is documentation, not a live vault
 * reference. Prefer this over {@link placeholderHoldsExampleMarkers} alone.
 */
export function isInertExamplePlaceholder(token: string) {
	if (placeholderHoldsExampleMarkers(token)) return true
	const vault = /^\{\{secret\/([a-zA-Z0-9._-]+):([^}]+)\}\}$/.exec(token.trim())
	if (!vault) return false
	const provider = vault[1]!.trim().toLowerCase()
	if (provider !== 'provider') return false
	const segments = vault[2]!
		.trim()
		.toLowerCase()
		.split('/')
		.filter((segment) => segment.length > 0)
	if (segments.length === 0) return false
	return segments.every(
		(segment) =>
			segment === vaultItemFormPrefix || vaultGrammarMetavariables.has(segment),
	)
}

export type ReferencedSecret = {
	name: string
	scope: SecretScope | null
	/** Per-run HMAC for package-scoped mounts (GHSA-5fv3 option b). */
	ref?: string | null
}

export type ReferencedBasicAuthSecretPlaceholder = {
	username: ReferencedSecret
	password: ReferencedSecret
	scope: SecretScope | null
}

export type ReferencedProviderSecret = {
	provider: string
	ref: string
	/** Exact `{{secret/...}}` token from the request, if parsed from text. */
	placeholder?: string
}

/**
 * Percent-decodes the punctuation of every placeholder form. WHATWG URL
 * serialization encodes `{` and `}` in a path, so `request.url` holds
 * `bot%7B%7Bsecret:name%7D%7D`, and `encodeURIComponent` or
 * `URLSearchParams` encode `:` and `|` too. Each is still found.
 */
export function decodeSecretPlaceholderPunctuation(value: string) {
	return value.replaceAll(/%(7B|7D|3A|2F|3D|2C|7C)/gi, (_, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	)
}

/** The decoded keys and values of a form-encoded string, in order. */
export function formUrlEncodedTexts(value: string) {
	return Array.from(new URLSearchParams(value)).flat()
}

export function parseSecretPlaceholders(value: string) {
	const secrets: Array<ReferencedSecret> = []
	for (const match of value.matchAll(secretPlaceholderRegex)) {
		if (placeholderHoldsExampleMarkers(match[0]!)) continue
		const name = match[1]?.trim()
		if (!name) continue
		const scope = match[2]
		const issuedRef = match[3]?.trim() || null
		secrets.push({
			name,
			scope:
				scope === 'package' || scope === 'session' || scope === 'user'
					? scope
					: null,
			...(issuedRef ? { ref: issuedRef } : {}),
		})
	}
	return secrets
}

export function parseBasicAuthSecretPlaceholders(value: string) {
	const placeholders: Array<ReferencedBasicAuthSecretPlaceholder> = []
	for (const match of value.matchAll(basicAuthSecretPlaceholderRegex)) {
		if (placeholderHoldsExampleMarkers(match[0]!)) continue
		const usernameSecretName = match[1]?.trim()
		const passwordSecretName = match[2]?.trim()
		if (!usernameSecretName || !passwordSecretName) continue
		const scope = parseSecretScope(match[3])
		placeholders.push({
			username: {
				name: usernameSecretName,
				scope,
			},
			password: {
				name: passwordSecretName,
				scope,
			},
			scope,
		})
	}
	return placeholders
}

export function parseProviderSecretPlaceholders(value: string) {
	const secrets: Array<ReferencedProviderSecret> = []
	for (const match of value.matchAll(providerSecretPlaceholderRegex)) {
		if (isInertExamplePlaceholder(match[0]!)) continue
		const provider = match[1]?.trim()
		const ref = match[2]?.trim()
		if (!provider || !ref) continue
		secrets.push({ provider, ref, placeholder: match[0] })
	}
	return secrets
}

export function buildProviderSecretPlaceholder(
	secret: ReferencedProviderSecret,
) {
	return secret.placeholder ?? `{{secret/${secret.provider}:${secret.ref}}}`
}

export function parseIntegrationTokenPlaceholders(value: string) {
	const names: Array<string> = []
	for (const match of value.matchAll(integrationTokenPlaceholderRegex)) {
		if (placeholderHoldsExampleMarkers(match[0]!)) continue
		const name = match[1]?.trim()
		if (name) names.push(name)
	}
	return names
}

export function buildIntegrationTokenPlaceholder(name: string) {
	return `{{integration-token:${name}}}`
}

export function buildSecretPlaceholder(secret: ReferencedSecret) {
	const scopePart = secret.scope ? `|scope=${secret.scope}` : ''
	const refPart = secret.ref ? `|ref=${secret.ref}` : ''
	return `{{secret:${secret.name}${scopePart}${refPart}}}`
}

export function buildBasicAuthSecretPlaceholder(input: {
	usernameSecret: string
	passwordSecret: string
	scope?: SecretScope | null
}) {
	return input.scope
		? `{{secret-basic:username=${input.usernameSecret},password=${input.passwordSecret}|scope=${input.scope}}}`
		: `{{secret-basic:username=${input.usernameSecret},password=${input.passwordSecret}}}`
}

export function buildBasicAuthSecretPlaceholderFromReference(
	placeholder: ReferencedBasicAuthSecretPlaceholder,
) {
	return buildBasicAuthSecretPlaceholder({
		usernameSecret: placeholder.username.name,
		passwordSecret: placeholder.password.name,
		scope: placeholder.scope,
	})
}

/**
 * Fills placeholders in a single pass over the original text. Matches come
 * from `value` only: a placeholder that appears inside an already-substituted
 * credential stays literal, so nested `{{secret:…}}` text in a stored value
 * cannot pull in another credential. A function replacer keeps `$&` and
 * friends in a value literal.
 */
export function replaceSecretPlaceholders(
	value: string,
	replacements: ReadonlyMap<string, string>,
) {
	if (replacements.size === 0) return value
	const placeholders = [...replacements.keys()].sort(
		(left, right) => right.length - left.length || left.localeCompare(right),
	)
	const pattern = new RegExp(
		placeholders.map(escapeRegExpLiteral).join('|'),
		'g',
	)
	return value.replace(pattern, (matched) => {
		const secretValue = replacements.get(matched)
		return secretValue === undefined ? matched : secretValue
	})
}

function escapeRegExpLiteral(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Fills placeholders in a form-encoded string (a body, or a query without its
 * `?`). Only a key or value that holds one is re-encoded. Separators and every
 * other component stay byte for byte, so a signature over them still verifies.
 */
export function replaceSecretPlaceholdersInFormUrlEncoded(
	value: string,
	replacements: ReadonlyMap<string, string>,
) {
	return value
		.split('&')
		.map((pair) => {
			const separator = pair.indexOf('=')
			if (separator === -1) return fillFormComponent(pair, replacements)
			const key = fillFormComponent(pair.slice(0, separator), replacements)
			const entryValue = fillFormComponent(
				pair.slice(separator + 1),
				replacements,
			)
			return `${key}=${entryValue}`
		})
		.join('&')
}

function fillFormComponent(
	raw: string,
	replacements: ReadonlyMap<string, string>,
) {
	// Decoded the way URLSearchParams decodes it, so it matches what
	// formUrlEncodedTexts found.
	const decoded = new URLSearchParams(`=${raw}`).get('') ?? ''
	const filled = replaceSecretPlaceholders(decoded, replacements)
	if (filled === decoded) return raw
	return new URLSearchParams([['', filled]]).toString().slice(1)
}

const pathPlaceholderSpan = /(?:\{|%7B){2}.*?(?:\}|%7D){2}/gi

/**
 * Fills placeholders in a URL path, whether their punctuation is literal or
 * percent-encoded. Each value is encoded as path-segment data, so a `/`, `?`,
 * `#`, or `..` in a credential cannot change where the request goes. The rest
 * of the path stays as written.
 */
export function replaceSecretPlaceholdersInPath(
	pathname: string,
	replacements: ReadonlyMap<string, string>,
) {
	const encoded = new Map<string, string>()
	for (const [placeholder, secretValue] of replacements) {
		encoded.set(placeholder, encodePathSegmentData(secretValue))
	}
	// Spans are matched across the whole path: a vault ref holds a `/`.
	const filled = pathname.replaceAll(pathPlaceholderSpan, (span) => {
		const decoded = decodeSecretPlaceholderPunctuation(span)
		const next = replaceSecretPlaceholders(decoded, encoded)
		return next === decoded ? span : next
	})
	// A parsed URL path holds no `.` or `..` segment (encoded or not), so one
	// here was formed by a credential, and URL parsing would move the request.
	if (
		filled !== pathname &&
		filled.split('/').some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))
	) {
		throw new Error(
			'A credential filled into the URL path would form a "." or ".." segment, which changes where the request goes, so Kody refused the request.',
		)
	}
	return filled
}

/**
 * `encodeURIComponent`, except that `:`, `@`, and RFC 3986 sub-delims stay
 * literal: they are valid inside a segment, and a token like Telegram's
 * `123:abc` must reach the remote as written.
 */
export function encodePathSegmentData(value: string) {
	return encodeURIComponent(value).replaceAll(
		/%(3A|40|24|26|2B|2C|3B|3D)/gi,
		(_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)),
	)
}

/**
 * Fills placeholders inside JSON text. Each value is JSON-escaped, so a quote
 * or backslash in a credential stays inside the string it replaces.
 */
export function replaceSecretPlaceholdersInJson(
	value: string,
	replacements: ReadonlyMap<string, string>,
) {
	const escaped = new Map<string, string>()
	for (const [placeholder, secretValue] of replacements) {
		escaped.set(placeholder, JSON.stringify(secretValue).slice(1, -1))
	}
	return replaceSecretPlaceholders(value, escaped)
}

/**
 * Accept a bare saved-secret name or a single opaque `{{secret:…}}`
 * placeholder (as returned by packageSecrets.get). Derived ops
 * (secretHeaders.basic, secretJwtSign) use this so package JS can pass
 * either form without ever seeing plaintext.
 */
export function parseSecretNameOrPlaceholder(
	value: string,
	fieldName: string,
): ReferencedSecret {
	const trimmed = value.trim()
	if (!trimmed) {
		throw new Error(`${fieldName} is required.`)
	}
	if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
		const parsed = parseSecretPlaceholders(trimmed)
		if (parsed.length !== 1 || buildSecretPlaceholder(parsed[0]!) !== trimmed) {
			throw new Error(
				`${fieldName} must be a saved secret name or a single {{secret:…}} opaque ref.`,
			)
		}
		return parsed[0]!
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
		throw new Error(
			`${fieldName} must be a saved secret name using letters, numbers, dots, underscores, or hyphens, or a single {{secret:…}} opaque ref.`,
		)
	}
	return { name: trimmed, scope: null }
}

export function containsSecretPlaceholder(value: string) {
	if (!/\{\{(?:secret(?:\/|:|-basic:)|integration-token:)/.test(value)) {
		return false
	}
	return (
		parseSecretPlaceholders(value).length > 0 ||
		parseBasicAuthSecretPlaceholders(value).length > 0 ||
		parseProviderSecretPlaceholders(value).length > 0 ||
		parseIntegrationTokenPlaceholders(value).length > 0
	)
}

function parseSecretScope(scope: string | undefined) {
	return scope === 'package' || scope === 'session' || scope === 'user'
		? scope
		: null
}
