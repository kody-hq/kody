import { type AccountEmailLoaderData } from '#universal/loader-data.ts'
import { searchText } from '../filter-search.ts'

export type EmailListInput = {
	org: string | null
	query: string
	classification: AccountEmailLoaderData['classification']
	page: number
	pageSize: number
}
export type EmailListData = Omit<AccountEmailLoaderData, 'selectedMessage'>
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
export function emailSearch(search: Record<string, unknown>): {
	q: string
	classification: EmailListInput['classification']
	page: number
	pageSize: number
	selected: string
} {
	return {
		q: searchText(search.q) ?? '',
		classification:
			search.classification === 'accepted' ||
			search.classification === 'quarantined'
				? search.classification
				: null,
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
			classification: search.classification,
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
				classification: input.classification,
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
	if (input.classification) search.set('classification', input.classification)
	return `${base}?${search}`
}
