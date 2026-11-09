export type ProcessInfo = {
	name: string
	cmd?: string
}

function processHaystack(process: ProcessInfo): string {
	return `${process.name} ${process.cmd ?? ''}`
}

function processBaseName(process: ProcessInfo): string {
	return process.name
		.replace(/\.exe$/iu, '')
		.trim()
		.toLowerCase()
}

export function nameEquals(
	process: ProcessInfo,
	...names: Array<string>
): boolean {
	const base = processBaseName(process)
	return names.some((name) => base === name.toLowerCase())
}

export function haystackMatches(
	process: ProcessInfo,
	pattern: RegExp,
): boolean {
	return pattern.test(processHaystack(process))
}
