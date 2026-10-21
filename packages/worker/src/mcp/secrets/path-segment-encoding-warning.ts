/**
 * Discoverability when a credential filled into a URL path contained routing
 * characters (`/`, `?`, `#`) that the gateway encoded as one segment, and the
 * upstream then returned 4xx. Agents see the warning on the response and in
 * run logs; the credential value never appears.
 */
import { withLanding } from './echo-redaction.ts'

/** Response header naming path-segment encoding on a 4xx (never a value). */
export const pathSegmentEncodingWarningHeaderName =
	'x-kody-path-segment-warning'

const pathRoutingCharacterPattern = /[/?#]/

/**
 * True when a credential value holds `/`, `?`, or `#` — characters that
 * `encodePathSegmentData` percent-encodes so they cannot change the route.
 */
export function credentialValueHasPathRoutingCharacters(value: string) {
	return pathRoutingCharacterPattern.test(value)
}

/**
 * Credential display names whose path fill encoded routing characters.
 * Names only — never values.
 */
export function pathSegmentEncodedCredentialNames(input: {
	pathname: string
	/** Placeholder text → plaintext value. */
	replacements: ReadonlyMap<string, string>
	/** Placeholder text → credential display name (secret name, etc.). */
	credentialNames: ReadonlyMap<string, string>
}): Array<string> {
	const names = new Set<string>()
	for (const [placeholder, value] of input.replacements) {
		if (!credentialValueHasPathRoutingCharacters(value)) continue
		if (!input.pathname.includes(placeholder)) continue
		const name = input.credentialNames.get(placeholder)
		if (name) names.add(name)
	}
	return [...names].sort((left, right) => left.localeCompare(right))
}

export function buildPathSegmentEncodingWarning(
	credentialName: string,
	status: number,
) {
	return (
		`Credential "${credentialName}" was filled into the URL path as one encoded segment ` +
		`(characters like /, ?, and # become %2F, %3F, %23). The remote returned ${status}. ` +
		`Prefer a literal path prefix plus a one-segment secret, for example ` +
		`https://hooks.example.com/services/{{secret:webhookToken}}.`
	)
}

/**
 * On a 4xx, attach a warning header for each path-encoded credential name.
 * Multiple names join with ` | ` so one header stays agent-readable.
 */
export function withPathSegmentEncodingWarning(
	response: Response,
	credentialNames: ReadonlyArray<string>,
) {
	if (credentialNames.length === 0) return response
	if (response.status < 400 || response.status > 499) return response
	const warning = credentialNames
		.map((name) => buildPathSegmentEncodingWarning(name, response.status))
		.join(' | ')
	const headers = new Headers(response.headers)
	headers.set(pathSegmentEncodingWarningHeaderName, warning)
	return withLanding(
		new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		}),
		{ url: response.url, redirected: response.redirected },
	)
}
