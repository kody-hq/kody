type StringListCompare = (left: string, right: string) => number

type NormalizeStringListInput = {
	values: Array<string>
	normalizeEntry: (value: string) => string
	compare?: StringListCompare
}

export function normalizeAllowedStringList(input: NormalizeStringListInput) {
	const values = Array.from(
		new Set(
			input.values
				.map((value) => input.normalizeEntry(value))
				.filter((value) => value.length > 0),
		),
	)
	return input.compare ? values.sort(input.compare) : values.sort()
}

export function parseAllowedStringList(
	value: string | null | undefined,
	normalizeList: (values: Array<string>) => Array<string>,
) {
	if (!value) return []
	try {
		const parsed = JSON.parse(value) as unknown
		if (!Array.isArray(parsed)) return []
		return normalizeList(
			parsed.filter((entry): entry is string => typeof entry === 'string'),
		)
	} catch {
		return []
	}
}
