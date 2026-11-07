function normalize(value: string) {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
}
function matchScore(text: string, query: string): number {
	if (text === query) return 180
	if (text.startsWith(query)) return 95
	if (text.split(/\W+/).some((word) => word.startsWith(query))) return 75
	if (text.includes(query)) return 60
	let cursor = -1
	let gaps = 0
	for (const character of query) {
		const next = text.indexOf(character, cursor + 1)
		if (next < 0) return 0
		if (cursor >= 0) gaps += next - cursor - 1
		cursor = next
	}
	return gaps > query.length * 2 ? 0 : Math.max(5, 35 - gaps)
}

/** Null means at least one search token did not match. */
export function commandTextScore(
	title: string,
	extra: string,
	query: string,
): number | null {
	const tokens = normalize(query).split(/\s+/).filter(Boolean)
	const scores = tokens.map((token) =>
		Math.max(
			matchScore(normalize(title), token),
			matchScore(normalize(extra), token) * 0.45,
		),
	)
	return scores.some((score) => !score)
		? null
		: scores.reduce((a, b) => a + b, 0)
}
