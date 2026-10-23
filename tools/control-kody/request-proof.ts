import path from 'node:path'

export function defaultDumpFile() {
	return path.join('.tmp', 'control-kody-body')
}

export function missingContainsNeedles(
	rawBody: string,
	needles: ReadonlyArray<string>,
) {
	return needles.filter((needle) => !rawBody.includes(needle))
}

export function formatContainsFailure(missing: ReadonlyArray<string>) {
	return missing
		.map((needle) => `response body does not contain ${JSON.stringify(needle)}`)
		.join('\n')
}
