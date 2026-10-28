/**
 * Client-safe shapes for an owner-approval request to widen a credential's
 * fill placement to the query, URL path, or body (`/connect/secrets?placement=`).
 * The host may store a value sent there, so only the owner can approve it on
 * the website; agents only build and share the link.
 */
import { type CredentialFillPlacementView } from './credential-fill-placement.ts'

export const placementApprovalParts = ['query', 'path', 'body'] as const

export type PlacementApprovalPart = (typeof placementApprovalParts)[number]

/** The `/connect/secrets` query parameter that requests placement parts. */
export const placementApprovalParam = 'placement'

/** The credential page anchor of the fill placement setting. */
export const fillPlacementAnchor = 'fill-placement'

const partAliases: Record<string, PlacementApprovalPart> = {
	query: 'query',
	path: 'path',
	url_path: 'path',
	'url-path': 'path',
	body: 'body',
}

/**
 * Comma or repeated `placement` values as known parts in canonical order.
 * Unknown values (including `headers`, which needs no opt-in) are dropped.
 */
export function normalizePlacementApprovalParts(
	values: ReadonlyArray<string>,
): Array<PlacementApprovalPart> {
	const requested = new Set<PlacementApprovalPart>()
	for (const value of values) {
		for (const raw of value.split(',')) {
			const part = partAliases[raw.trim().toLowerCase()]
			if (part) requested.add(part)
		}
	}
	return placementApprovalParts.filter((part) => requested.has(part))
}

function placementApprovalPartLabel(part: PlacementApprovalPart) {
	switch (part) {
		case 'query':
			return 'query'
		case 'path':
			return 'URL path'
		case 'body':
			return 'body'
		default: {
			const exhaustive: never = part
			return exhaustive
		}
	}
}

/** "body", "query and body", "query, URL path, and body". */
export function formatPlacementApprovalParts(
	parts: ReadonlyArray<PlacementApprovalPart>,
) {
	const labels = parts.map(placementApprovalPartLabel)
	if (labels.length <= 1) return labels[0] ?? ''
	if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
	return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`
}

type CredentialPlacementApprovalItem = {
	name: string
	/** The stored placement before approval. Null means not set (legacy). */
	placement: CredentialFillPlacementView | null
	/** Requested parts the credential cannot fill yet. */
	pendingParts: Array<PlacementApprovalPart>
	/** The placement after approval. */
	placementAfter: CredentialFillPlacementView | null
}

export type CredentialPlacementApprovalView = {
	parts: Array<PlacementApprovalPart>
	credentials: Array<CredentialPlacementApprovalItem>
	/** Requested names with no saved user credential. */
	missingNames: Array<string>
}
