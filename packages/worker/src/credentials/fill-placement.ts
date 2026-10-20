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
import {
	scheduleFillPlacementObservation,
	type FillPlacementPartKey,
} from '#worker/credentials/fill-placement-observations.ts'

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
 * that separately via {@link fillPlacementAllowsUnderResolution}.
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

/**
 * Per-request `x-kody-secret-resolution` mode. `headers-only` intersects with
 * placement (never widens it); the gateway also omits URL/body sources under
 * that mode so those sites never reach resolve.
 */
export type SecretResolutionFillMode = 'on' | 'headers-only'

/**
 * Placement check composed with the per-request resolution mode.
 * `headers-only` refuses every non-header site even when placement allows it.
 */
export function fillPlacementAllowsUnderResolution(
	placement: CredentialFillPlacement | null,
	site: CredentialFillSite,
	resolutionMode: SecretResolutionFillMode,
): boolean {
	if (resolutionMode === 'headers-only' && site.part !== 'header') return false
	return fillPlacementAllows(placement, site)
}

/** One label for logs and refusal messages (`header Authorization`, `body`, …). */
export function fillPlacementSiteLabel(site: CredentialFillSite): string {
	switch (site.part) {
		case 'header':
			return `header ${site.name}`
		case 'query':
			return 'query'
		case 'path':
			return 'path'
		case 'body':
			return 'body'
		default: {
			const exhaustive: never = site
			throw new Error(`Unhandled fill site: ${String(exhaustive)}`)
		}
	}
}

/**
 * Clear refusal copy for enforcement (and the would-block log). Never includes
 * credential values.
 */
export function fillPlacementRefusalMessage(input: {
	credentialName: string
	site: CredentialFillSite
	placement: CredentialFillPlacement | null
}): string {
	const allowed = fillPlacementPartLabels(input.placement).join(', ')
	return `Credential "${input.credentialName}" may not fill ${fillPlacementSiteLabel(input.site)}. Allowed parts: ${allowed}.`
}

export type FillPlacementObserveSurface = 'placeholder' | 'credential-client'

function fillPlacementPartKey(site: CredentialFillSite): FillPlacementPartKey {
	return site.part === 'header' ? 'headers' : site.part
}

/**
 * Observe-mode: durable per-credential records of parts that were filled and
 * parts that would have been refused, without blocking. Never values.
 */
export function observeFillPlacementWouldBlock(input: {
	credentialName: string
	placement: CredentialFillPlacement | null
	site: CredentialFillSite
	surface: FillPlacementObserveSurface
	resolutionMode?: SecretResolutionFillMode
	env?: Pick<Env, 'APP_DB'>
	credentialId?: string | null
}): void {
	const mode = input.resolutionMode ?? 'on'
	const allowed = fillPlacementAllowsUnderResolution(
		input.placement,
		input.site,
		mode,
	)
	const part = fillPlacementPartKey(input.site)
	if (!input.env || !input.credentialId) return
	scheduleFillPlacementObservation({
		env: input.env,
		credentialId: input.credentialId,
		filledParts: allowed ? [part] : [],
		wouldBlockParts: allowed ? [] : [part],
	})
}

/** Observe each site. Dedupes identical part keys into one durable write. */
export function observeFillPlacementWouldBlockSites(input: {
	credentialName: string
	placement: CredentialFillPlacement | null
	sites: ReadonlyArray<CredentialFillSite>
	surface: FillPlacementObserveSurface
	resolutionMode?: SecretResolutionFillMode
	env?: Pick<Env, 'APP_DB'>
	credentialId?: string | null
}): void {
	if (!input.env || !input.credentialId) return
	const mode = input.resolutionMode ?? 'on'
	const seen = new Set<string>()
	const filledParts: Array<FillPlacementPartKey> = []
	const wouldBlockParts: Array<FillPlacementPartKey> = []
	for (const site of input.sites) {
		const key = fillPlacementPartKey(site)
		if (seen.has(key)) continue
		seen.add(key)
		const allowed = fillPlacementAllowsUnderResolution(
			input.placement,
			site,
			mode,
		)
		if (allowed) filledParts.push(key)
		else wouldBlockParts.push(key)
	}
	scheduleFillPlacementObservation({
		env: input.env,
		credentialId: input.credentialId,
		filledParts,
		wouldBlockParts,
	})
}

/**
 * Fill site for a scoped `credential()` inject. Inject kinds today are only
 * header, basic (Authorization header), and query — no path or body inject.
 */
export function fillSiteFromCredentialInject(
	inject:
		| { kind: 'header'; name: string }
		| { kind: 'basic' }
		| { kind: 'query' },
): CredentialFillSite {
	switch (inject.kind) {
		case 'header':
			return { part: 'header', name: inject.name }
		case 'basic':
			return { part: 'header', name: 'Authorization' }
		case 'query':
			return { part: 'query' }
		default: {
			const exhaustive: never = inject
			throw new Error(`Unhandled inject: ${String(exhaustive)}`)
		}
	}
}
