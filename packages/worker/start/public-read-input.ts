import { notFound } from '@tanstack/react-router'

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
		installOrg: params.get('org')?.trim() || null,
	}
}
/**
 * `/@` matches the optional `@{$username}` segment with an empty string.
 * Resolve it as not-found before it reaches loadProfile's validator.
 */
export function profileReadInput(username: string, search: string) {
	if (!username) throw notFound()
	const params = new URLSearchParams(search)
	return {
		username,
		query: params.has('limit') ? (params.get('q')?.trim() ?? '') : '',
		limit: optionalLimit(params.get('limit')),
	}
}
