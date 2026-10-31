import {
	defaultEmailMessageView,
	isEmailMessageView,
	type EmailMessageView,
} from '#universal/email-message-view.ts'
import { type AccountEmailLoaderData } from '#universal/loader-data.ts'
import { searchText } from '../filter-search.ts'

export type EmailListInput = {
	org: string | null
	query: string
	view: EmailMessageView
	page: number
	pageSize: number
}
export type EmailListData = Omit<AccountEmailLoaderData, 'selectedMessage'>
/** A member without the org-wide `email:read` grant. Expected, not a failure. */
export type EmailMissingGrant = { missingGrant: 'email:read' }
export type EmailListResult = EmailListData | EmailMissingGrant
export function isEmailMissingGrant(
	value: EmailListResult | undefined,
): value is EmailMissingGrant {
	return value !== undefined && 'missingGrant' in value
}
export type EmailDetail = AccountEmailLoaderData['selectedMessage']

function positive(
	value: unknown,
	fallback: number,
	max = Number.MAX_SAFE_INTEGER,
) {
	const parsed = Number.parseInt(String(value ?? ''), 10)
	return Number.isFinite(parsed) && parsed > 0
		? Math.min(parsed, max)
		: fallback
}
/** `classification=quarantined` is the pre-view spelling of the same filter. */
function readView(search: Record<string, unknown>): EmailMessageView {
	if (isEmailMessageView(search.view)) return search.view
	if (
		search.classification === 'quarantined' ||
		search.classification === 'spam'
	)
		return search.classification
	return defaultEmailMessageView
}
export function emailSearch(search: Record<string, unknown>): {
	q: string
	view: EmailMessageView
	page: number
	pageSize: number
	selected: string
} {
	return {
		q: searchText(search.q) ?? '',
		view: readView(search),
		page: positive(search.page, 1),
		pageSize: positive(search.pageSize, 25, 100),
		selected: typeof search.selected === 'string' ? search.selected.trim() : '',
	}
}
export function emailResourceInput(
	params: { orgSlug: string | null; messageId?: string },
	search: ReturnType<typeof emailSearch>,
) {
	return {
		list: {
			org: params.orgSlug,
			query: search.q.trim(),
			view: search.view,
			page: search.page,
			pageSize: search.pageSize,
		} satisfies EmailListInput,
		messageId: params.messageId || search.selected || null,
	}
}
export type EmailResourceInput = ReturnType<typeof emailResourceInput>

export const emailKeys = {
	all: (actor: string | null, org: string | null) =>
		['email', actor, org] as const,
	lists: (actor: string | null, org: string | null) =>
		[...emailKeys.all(actor, org), 'list'] as const,
	list: (actor: string | null, input: EmailListInput) =>
		[
			...emailKeys.lists(actor, input.org),
			{
				query: input.query,
				view: input.view,
				page: input.page,
				pageSize: input.pageSize,
			},
		] as const,
	detail: (actor: string | null, org: string | null, id: string | null) =>
		[...emailKeys.all(actor, org), 'detail', id] as const,
	destinations: (actor: string | null) =>
		['email-destinations', actor] as const,
	mutations: (actor: string | null, org: string | null) =>
		['email-write', actor, org] as const,
}
export function emailListHref(input: EmailListInput) {
	const base =
		input.org === null
			? '/account/email'
			: `/@${encodeURIComponent(input.org)}/-/email`
	const search = new URLSearchParams({
		q: input.query,
		page: String(input.page),
		pageSize: String(input.pageSize),
	})
	if (input.view !== defaultEmailMessageView) search.set('view', input.view)
	return `${base}?${search}`
}
