/**
 * Publish check for credential placeholders a fetch sends in a request body,
 * URL path, URL query, or whole URL. The fetch gateway fills those parts only
 * when the credential's owner allowed the part in its fill placement (ADR
 * 0068), so a package that relies on one breaks when the owner narrows the
 * placement or the rule tightens. Names come from the source; values never do.
 */
import {
	type CredentialPlacement,
	scanPackageCredentials,
} from './credential-inventory-scan.ts'

/**
 * The single switch for this check. `fail` fails authoring publish; `warn`
 * appends a warning and publishes. Community installs and platform codemods
 * (`enforceCredentialStamp: false`) always only warn, so republishing existing
 * packages never breaks.
 */
export const secretPlaceholderRequestPlacementPublishMode: SecretPlaceholderRequestPlacementMode =
	'fail'

export type SecretPlaceholderRequestPlacementMode = 'warn' | 'fail'

export type SecretPlaceholderRequestPart = 'body' | 'query' | 'path' | 'url'

export type SecretPlaceholderRequestPlacementHit = {
	path: string
	line: number | null
	nameKind: 'secret' | 'integration'
	name: string
	part: SecretPlaceholderRequestPart
}

const maxListedHits = 10

const partPhrases: Record<SecretPlaceholderRequestPart, string> = {
	body: 'the request body',
	query: 'the URL query',
	path: 'the URL path',
	url: 'the URL',
}

export function requestPartOfPlacement(
	placement: CredentialPlacement,
): SecretPlaceholderRequestPart | null {
	switch (placement.type) {
		case 'body':
		case 'query':
		case 'path':
		case 'url':
			return placement.type
		case 'other':
			return placement.context === 'url-host' ? 'url' : null
		case 'header':
		case 'header-custom':
		case 'basic':
		case 'signing':
		case 'binding':
			return null
		default: {
			const exhaustive: never = placement
			throw new Error(`Unhandled placement: ${String(exhaustive)}`)
		}
	}
}

export function findSecretPlaceholderRequestPlacements(
	files: Record<string, string>,
): Array<SecretPlaceholderRequestPlacementHit> {
	const scan = scanPackageCredentials({ files, slots: undefined, sites: true })
	const seen = new Set<string>()
	const hits: Array<SecretPlaceholderRequestPlacementHit> = []
	for (const reference of scan.references) {
		const part = requestPartOfPlacement(reference.placement)
		if (!part || !reference.site) continue
		const hit = {
			path: reference.site.path,
			line: reference.site.line,
			nameKind: reference.nameKind,
			name: reference.name,
			part,
		}
		const key = `${hit.path}:${hit.line}:${hit.nameKind}:${hit.name}:${part}`
		if (seen.has(key)) continue
		seen.add(key)
		hits.push(hit)
	}
	return hits.sort(
		(left, right) =>
			left.path.localeCompare(right.path) ||
			(left.line ?? 0) - (right.line ?? 0) ||
			left.name.localeCompare(right.name),
	)
}

function formatHit(hit: SecretPlaceholderRequestPlacementHit) {
	const where = hit.line == null ? hit.path : `${hit.path}:${hit.line}`
	const what = hit.nameKind === 'secret' ? 'secret' : 'integration token'
	return `- ${where}: ${what} "${hit.name}" in ${partPhrases[hit.part]}`
}

export function formatSecretPlaceholderRequestPlacementNotice(input: {
	hits: ReadonlyArray<SecretPlaceholderRequestPlacementHit>
	mode: SecretPlaceholderRequestPlacementMode
}): string | null {
	if (input.hits.length === 0) return null
	const shown = input.hits.slice(0, maxListedHits)
	const extra = input.hits.length - shown.length
	const lead =
		input.mode === 'fail'
			? 'Publish failed: a fetch puts a credential placeholder in a request body, URL, or query.'
			: 'WARNING: a fetch puts a credential placeholder in a request body, URL, or query.'
	return [
		lead,
		...shown.map(formatHit),
		...(extra > 0 ? [`- and ${extra} more`] : []),
		"The fetch gateway fills a credential there only when the credential's owner allowed that part in its fill placement; otherwise Kody refuses the request (credential_placement_refused) and the run fails.",
		"Fix: move the credential into a request header the API reads (for example headers: { Authorization: 'Bearer {{secret:name}}' }). A value that is not a credential, such as an account id, can be a constant in the package source instead.",
		input.mode === 'fail'
			? 'This blocks publish.'
			: "If the API only reads it from that part, the credential's owner can allow the part on the credential page. This does not block publish.",
	].join('\n')
}
