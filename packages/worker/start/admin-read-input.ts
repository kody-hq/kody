/** Match existing admin URL pagination while sending typed RPC inputs. */
export function adminPageNumber(
	value: string | null,
	fallback: number,
	max = Number.MAX_SAFE_INTEGER,
) {
	const parsed = Number.parseInt(value ?? '', 10)
	return Number.isFinite(parsed) && parsed > 0
		? Math.min(parsed, max)
		: fallback
}
