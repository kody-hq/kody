export function parseCiShard(value: string | undefined) {
	if (!value) return undefined
	const match = /^(\d+)\/(\d+)$/.exec(value)
	const current = Number(match?.[1])
	const total = Number(match?.[2])
	if (
		!Number.isSafeInteger(current) ||
		!Number.isSafeInteger(total) ||
		current < 1 ||
		current > total
	) {
		throw new Error(`Invalid CI shard: ${value}; expected index/total`)
	}
	return { current, total }
}
