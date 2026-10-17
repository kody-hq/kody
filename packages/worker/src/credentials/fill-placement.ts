/**
 * Where the fetch gateway may fill a credential's placeholders (secret,
 * secret-basic, integration-token, vault). Distinct from `inject`, which only
 * steers the scoped `credential()` client.
 *
 * Stored as `placement_json`: null/absent means anywhere (today's behavior).
 * A non-null object lists the request parts the credential may fill into.
 * Enforcement ships later; this module is the shared schema and helpers.
 */
import { z } from 'zod'

/** RFC 9110 token characters for HTTP field names. */
const httpFieldNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

const namedHeadersSchema = z
	.array(
		z
			.string()
			.regex(
				httpFieldNamePattern,
				'A header name uses only RFC 9110 token characters.',
			)
			.min(1)
			.max(100),
	)
	.min(1)
	.max(50)

/**
 * Allowed fill sites for placeholders. At least one part must be present.
 * `headers: true` allows any header name; a string array limits to those names.
 */
export const credentialFillPlacementSchema = z
	.object({
		headers: z.union([z.literal(true), namedHeadersSchema]).optional(),
		query: z.literal(true).optional(),
		path: z.literal(true).optional(),
		body: z.literal(true).optional(),
	})
	.strict()
	.refine(
		(placement) =>
			placement.headers !== undefined ||
			placement.query === true ||
			placement.path === true ||
			placement.body === true,
		{ message: 'Placement must allow at least one request part.' },
	)

export type CredentialFillPlacement = z.infer<
	typeof credentialFillPlacementSchema
>

/**
 * Default for newly created credentials (headers only). Existing rows keep
 * null until migration narrows them; null means anywhere.
 */
export const defaultNewCredentialFillPlacement: CredentialFillPlacement = {
	headers: true,
}

/** Human-readable parts for errors and UI (`headers`, `query`, `path`, `body`). */
export function fillPlacementPartLabels(
	placement: CredentialFillPlacement | null,
): Array<string> {
	if (placement === null) return ['headers', 'query', 'path', 'body']
	const parts: Array<string> = []
	if (placement.headers !== undefined) parts.push('headers')
	if (placement.query === true) parts.push('query')
	if (placement.path === true) parts.push('path')
	if (placement.body === true) parts.push('body')
	return parts
}

/** Parse a stored `placement_json` value. Null/invalid → anywhere (null). */
export function readCredentialFillPlacement(
	placementJson: string | null | undefined,
): CredentialFillPlacement | null {
	if (placementJson == null || placementJson === '') return null
	let parsed: unknown
	try {
		parsed = JSON.parse(placementJson)
	} catch {
		return null
	}
	if (parsed === null) return null
	const placement = credentialFillPlacementSchema.safeParse(parsed)
	return placement.success ? placement.data : null
}

export function serializeCredentialFillPlacement(
	placement: CredentialFillPlacement | null,
): string | null {
	return placement === null ? null : JSON.stringify(placement)
}

/**
 * A fill site observed at gateway time. Named headers carry the header name
 * so a limited header list can be checked.
 */
export type CredentialFillSite =
	| { part: 'header'; name: string }
	| { part: 'query' }
	| { part: 'path' }
	| { part: 'body' }

/**
 * Whether `site` is allowed by `placement`. Null placement allows everywhere.
 * Does not apply the per-request `headers-only` intersection; callers compose
 * that separately.
 */
export function fillPlacementAllows(
	placement: CredentialFillPlacement | null,
	site: CredentialFillSite,
): boolean {
	if (placement === null) return true
	switch (site.part) {
		case 'header': {
			const allowed = placement.headers
			if (allowed === undefined) return false
			if (allowed === true) return true
			return allowed.some(
				(name) => name.toLowerCase() === site.name.toLowerCase(),
			)
		}
		case 'query':
			return placement.query === true
		case 'path':
			return placement.path === true
		case 'body':
			return placement.body === true
		default: {
			const exhaustive: never = site
			throw new Error(`Unhandled fill site: ${String(exhaustive)}`)
		}
	}
}
