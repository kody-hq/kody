export function sessionNumber(id: string) {
	let result = 2166136261
	for (const c of id) result = Math.imul(result ^ c.charCodeAt(0), 16777619)
	return result >>> 0
}
export function actorColor(id: string) {
	return ['#6b62c7', '#b25475', '#267e78', '#a66d28', '#497cb5'][
		sessionNumber(id) % 5
	]!
}
