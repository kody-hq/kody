import { matchesSearchQuery } from '#client/search-filter.ts'
import { type AdminProviderMark } from '#universal/loader-data.ts'

export function splitAliasInput(raw: string): Array<string> {
	return raw
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean)
}

export function filterMarks(marks: Array<AdminProviderMark>, search: string) {
	return marks.filter((mark) =>
		matchesSearchQuery(search, [
			mark.slug,
			mark.label,
			...mark.aliases,
			...mark.builtInAliases,
		]),
	)
}

export function markGroupKey(slug: string) {
	const first = slug.trim().charAt(0).toLowerCase()
	return /[a-z]/.test(first) ? first.toUpperCase() : '#'
}

export function groupMarks(marks: ReadonlyArray<AdminProviderMark>): Array<{
	key: string
	marks: Array<AdminProviderMark>
}> {
	const groups = new Map<string, Array<AdminProviderMark>>()
	for (const mark of marks) {
		const key = markGroupKey(mark.slug)
		const existing = groups.get(key)
		if (existing) existing.push(mark)
		else groups.set(key, [mark])
	}
	return [...groups.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, grouped]) => ({ key, marks: grouped }))
}
