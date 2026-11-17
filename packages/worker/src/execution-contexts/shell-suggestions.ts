/**
 * What an unrestricted shell was used for, from the audit log, so its
 * operator can narrow it: the packages whose runs used it (a package list
 * for the shell) and the programs they ran (candidates for named commands).
 */

export type ShellCommandUse = {
	at: string
	command: string
	/** Saved packages the run loaded directly. Empty for ad hoc code. */
	entryPackageIds: Array<string>
}

const maxPrograms = 20
const maxExamples = 3
const maxExampleChars = 200

/** Pipes, chaining, redirects, substitution and globs need a shell. */
const shellSyntax = /[|&;<>`$*?(){}\n]/

/**
 * Whether the command needs a shell to mean what it says. Quoted text is
 * literal, except `$` and backticks inside double quotes.
 */
export function commandNeedsShell(command: string) {
	const unquoted = command
		.replace(/'[^']*'/g, '')
		.replace(/"((?:[^"\\]|\\.)*)"/g, (_, inner: string) =>
			inner.replace(/\\.|[^`$]/g, ''),
		)
	return shellSyntax.test(unquoted)
}

export function readShellCommandUse(row: {
	at: string
	detailJson: string
}): ShellCommandUse | null {
	let detail: unknown
	try {
		detail = JSON.parse(row.detailJson)
	} catch {
		return null
	}
	if (!detail || typeof detail !== 'object') return null
	const { command, entryPackageIds } = detail as Record<string, unknown>
	if (typeof command !== 'string' || command.trim() === '') return null
	return {
		at: row.at,
		command,
		entryPackageIds: Array.isArray(entryPackageIds)
			? entryPackageIds.filter((id): id is string => typeof id === 'string')
			: [],
	}
}

/** The program a shell command starts with, past leading `NAME=value` words. */
export function shellCommandProgram(command: string) {
	const words = command.trim().split(/\s+/)
	const word = words.find((part) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(part))
	return word ?? words[0] ?? ''
}

export function summarizeShellUse(uses: ReadonlyArray<ShellCommandUse>) {
	const packages = new Map<string, { commands: number; lastUsedAt: string }>()
	const programs = new Map<
		string,
		{
			commands: number
			needShell: number
			examples: Array<string>
			packageIds: Set<string>
			adHoc: number
		}
	>()
	let adHocCommands = 0
	for (const use of uses) {
		if (use.entryPackageIds.length === 0) adHocCommands += 1
		for (const id of new Set(use.entryPackageIds)) {
			const seen = packages.get(id)
			if (!seen) packages.set(id, { commands: 1, lastUsedAt: use.at })
			else {
				seen.commands += 1
				if (use.at > seen.lastUsedAt) seen.lastUsedAt = use.at
			}
		}
		const name = shellCommandProgram(use.command)
		const program = programs.get(name) ?? {
			commands: 0,
			needShell: 0,
			examples: [],
			packageIds: new Set<string>(),
			adHoc: 0,
		}
		programs.set(name, program)
		program.commands += 1
		if (commandNeedsShell(use.command)) program.needShell += 1
		if (use.entryPackageIds.length === 0) program.adHoc += 1
		for (const id of use.entryPackageIds) program.packageIds.add(id)
		const example = use.command.trim().slice(0, maxExampleChars)
		if (
			program.examples.length < maxExamples &&
			!program.examples.includes(example)
		) {
			program.examples.push(example)
		}
	}
	const sortedPrograms = [...programs.entries()].sort(
		([a, x], [b, y]) => y.commands - x.commands || a.localeCompare(b),
	)
	return {
		adHocCommands,
		packages: [...packages.entries()]
			.map(([packageId, seen]) => ({ packageId, ...seen }))
			.sort(
				(a, b) =>
					b.commands - a.commands || a.packageId.localeCompare(b.packageId),
			),
		programs: sortedPrograms.slice(0, maxPrograms).map(([program, seen]) => ({
			program,
			commands: seen.commands,
			needShell: seen.needShell,
			adHocCommands: seen.adHoc,
			packageIds: [...seen.packageIds].sort(),
			examples: seen.examples,
		})),
		morePrograms: Math.max(0, sortedPrograms.length - maxPrograms),
	}
}
