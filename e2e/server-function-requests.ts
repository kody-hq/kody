import { type Page, type Request } from './playwright-utils.ts'

/** Match the root RPC input, not nested values from context or another request. */
export function requestHasDataFields(
	request: Pick<Request, 'url' | 'method'>,
	fields: Record<string, string | null | undefined>,
	excludedFields: string[] = [],
) {
	const url = new URL(request.url())
	if (request.method() !== 'GET' || !url.pathname.startsWith('/_serverFn/'))
		return false
	return serializedDataMatches(
		url.searchParams.get('payload') ?? '',
		fields,
		excludedFields,
	)
}

export function requestHasMutationDataFields(
	request: Pick<Request, 'url' | 'method' | 'postData'>,
	fields: Record<string, string | null | undefined>,
) {
	if (
		request.method() !== 'POST' ||
		!new URL(request.url()).pathname.startsWith('/_serverFn/')
	)
		return false
	return serializedDataMatches(request.postData() ?? '', fields, [])
}

function serializedDataMatches(
	serialized: string,
	fields: Record<string, string | null | undefined>,
	excludedFields: string[],
) {
	try {
		const root = JSON.parse(serialized).t?.p
		const input = root?.v?.[root.k.indexOf('data')]?.p
		if (
			!Array.isArray(input?.k) ||
			excludedFields.some((key) => input.k.includes(key))
		)
			return false
		return Object.entries(fields).every(([key, value]) => {
			const index = input.k.indexOf(key)
			if (index < 0) return false
			const node = input.v[index]
			return value === undefined
				? node?.t === 2 && node.s === 1
				: value === null
					? node?.t === 2 && node.s === 0
					: node?.t === 1 && node.s === value
		})
	} catch {
		return false
	}
}

export function waitForOrgRead(page: Page, orgSlug: string) {
	return page.waitForResponse((response) =>
		requestHasDataFields(response.request(), { orgSlug }, ['section']),
	)
}
