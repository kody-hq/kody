function optionalLimit(value: string | null) {
	const parsed = Number.parseInt(value ?? '', 10)
	return Number.isFinite(parsed) && parsed > 0
		? Math.min(parsed, 100)
		: undefined
}
export function communityReadInput(search: string) {
	const params = new URLSearchParams(search)
	return {
		query: params.get('q')?.trim() ?? '',
		sort: params.get('sort'),
		category: params.get('category'),
		limit: optionalLimit(params.get('limit')) ?? 50,
	}
}
export function profileReadInput(username: string, search: string) {
	const params = new URLSearchParams(search)
	return {
		username,
		query: params.has('limit') ? (params.get('q')?.trim() ?? '') : '',
		limit: optionalLimit(params.get('limit')),
	}
}
