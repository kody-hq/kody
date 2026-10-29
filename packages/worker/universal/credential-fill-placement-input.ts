import { z } from 'zod'
import {
	type CredentialFillPlacementView,
	type FillPlacementDraft,
} from './credential-fill-placement.ts'

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

/**
 * Build a placement view from editor draft checkboxes.
 * Returns `null` for intentional anywhere (all parts, any header) or when no
 * parts are selected. Throws when named headers (or the shape) are invalid so
 * callers cannot confuse a bad name list with unrestricted fill.
 */
export function fillPlacementViewFromDraft(
	draft: FillPlacementDraft,
): CredentialFillPlacementView | null {
	const named = draft.namedHeaders
		.split(',')
		.map((name) => name.trim())
		.filter((name) => name.length > 0)
	if (!draft.headers && !draft.query && !draft.path && !draft.body) {
		return null
	}
	const placement: CredentialFillPlacementView = {}
	if (draft.headers) {
		// Empty field → any header. Non-empty input that yields no names
		// (e.g. ", ,") stays an empty array so the schema rejects it.
		placement.headers = draft.namedHeaders.trim().length === 0 ? true : named
	}
	if (draft.query) placement.query = true
	if (draft.path) placement.path = true
	if (draft.body) placement.body = true
	const parsed = credentialFillPlacementViewSchema.safeParse(placement)
	if (!parsed.success) {
		throw new Error(
			parsed.error.issues[0]?.message ?? 'Invalid fill placement.',
		)
	}
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
