/**
 * Client-safe fill-placement shapes and labels. The gateway schema and
 * enforcement live in `#worker/credentials/fill-placement.ts`; this module
 * only formats what the UI already received.
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
 * Where placeholders may be filled. Null means anywhere. Distinct from
 * `inject` (scoped credential() client only).
 */
export const credentialFillPlacementViewSchema = z
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

export type CredentialFillPlacementView = z.infer<
	typeof credentialFillPlacementViewSchema
>

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
	if (placement === null) return 'Anywhere (headers, query, path, body)'
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

export function fillPlacementViewFromDraft(
	draft: FillPlacementDraft,
): CredentialFillPlacementView | null {
	const named = draft.namedHeaders
		.split(',')
		.map((name) => name.trim())
		.filter((name) => name.length > 0)
	const placement: CredentialFillPlacementView = {}
	if (draft.headers) {
		placement.headers = named.length > 0 ? named : true
	}
	if (draft.query) placement.query = true
	if (draft.path) placement.path = true
	if (draft.body) placement.body = true
	const parsed = credentialFillPlacementViewSchema.safeParse(placement)
	if (!parsed.success) return null
	// All four parts with any-header is stored as null (anywhere) so existing
	// "anywhere" rows stay distinguishable from an explicit object.
	if (
		parsed.data.headers === true &&
		parsed.data.query === true &&
		parsed.data.path === true &&
		parsed.data.body === true
	) {
		return null
	}
	return parsed.data
}
