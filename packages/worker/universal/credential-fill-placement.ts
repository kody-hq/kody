/**
 * Client-safe fill-placement shapes and labels. The gateway schema and
 * enforcement live in `#worker/credentials/fill-placement.ts`; this module
 * only formats what the UI already received.
 */
/** Where credential placeholders may be filled. Null means anywhere. */
export type CredentialFillPlacementView = {
	headers?: true | Array<string>
	query?: true
	path?: true
	body?: true
}

export const fillPlacementPartIds = [
	'headers',
	'query',
	'path',
	'body',
] as const

export type FillPlacementPartId = (typeof fillPlacementPartIds)[number]

/** One-line summary for metadata grids. */
export function formatFillPlacementSummary(
	placement: CredentialFillPlacementView | null,
): string {
	if (placement === null) return 'Not set (headers, plus parts used before)'
	const parts: Array<string> = []
	if (placement.headers !== undefined) parts.push('headers')
	if (placement.query === true) parts.push('query')
	if (placement.path === true) parts.push('path')
	if (placement.body === true) parts.push('body')
	if (
		placement.headers !== undefined &&
		placement.headers !== true &&
		Array.isArray(placement.headers)
	) {
		const named = placement.headers.join(', ')
		const rest = parts.filter((part) => part !== 'headers')
		const headersBit = `headers (${named})`
		return rest.length > 0 ? `${headersBit}, ${rest.join(', ')}` : headersBit
	}
	return parts.join(', ')
}

/** Draft state for the fill-placement checkboxes on create/edit forms. */
export type FillPlacementDraft = {
	headers: boolean
	query: boolean
	path: boolean
	body: boolean
	/** Comma-separated named headers when headers is on; empty means any header. */
	namedHeaders: string
}

export function fillPlacementDraftFromView(
	placement: CredentialFillPlacementView | null,
): FillPlacementDraft {
	if (placement === null) {
		return {
			headers: true,
			query: true,
			path: true,
			body: true,
			namedHeaders: '',
		}
	}
	return {
		headers: placement.headers !== undefined,
		query: placement.query === true,
		path: placement.path === true,
		body: placement.body === true,
		namedHeaders:
			placement.headers !== undefined && placement.headers !== true
				? placement.headers.join(', ')
				: '',
	}
}

export function defaultFillPlacementDraft(): FillPlacementDraft {
	return {
		headers: true,
		query: false,
		path: false,
		body: false,
		namedHeaders: '',
	}
}
