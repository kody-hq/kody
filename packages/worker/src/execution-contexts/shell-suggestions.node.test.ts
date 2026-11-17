import { expect, test } from 'vitest'
import {
	commandNeedsShell,
	readShellCommandUse,
	shellCommandProgram,
	summarizeShellUse,
} from './shell-suggestions.ts'

test('a shell command is grouped by the program it starts with, past env assignments', () => {
	expect(shellCommandProgram('docker restart plex')).toBe('docker')
	expect(shellCommandProgram('  FOO=1 BAR=x node build.mjs')).toBe('node')
	expect(shellCommandProgram('FOO=1')).toBe('FOO=1')
})

test('an audit row with no command text is skipped, and one without packages is ad hoc', () => {
	const at = '2026-11-01T00:00:00.000Z'
	expect(readShellCommandUse({ at, detailJson: 'not json' })).toBeNull()
	expect(readShellCommandUse({ at, detailJson: '{"command":" "}' })).toBeNull()
	expect(
		readShellCommandUse({ at, detailJson: '{"command":"ls","runId":"r"}' }),
	).toEqual({ at, command: 'ls', entryPackageIds: [] })
})

test('shell use is summarized into packages to list and programs to name', () => {
	const use = (
		at: string,
		command: string,
		entryPackageIds: Array<string> = [],
	) => ({ at, command, entryPackageIds })
	const summary = summarizeShellUse([
		use('2026-11-03', 'docker restart plex', ['pkg_media']),
		use('2026-11-02', 'docker ps | grep plex', ['pkg_media', 'pkg_ops']),
		use('2026-11-01', 'docker restart plex', ['pkg_media']),
		use('2026-11-01', 'ls /volume1'),
	])
	expect(summary.adHocCommands).toBe(1)
	expect(summary.packages).toEqual([
		{ packageId: 'pkg_media', commands: 3, lastUsedAt: '2026-11-03' },
		{ packageId: 'pkg_ops', commands: 1, lastUsedAt: '2026-11-02' },
	])
	expect(summary.programs).toEqual([
		{
			program: 'docker',
			commands: 3,
			needShell: 1,
			adHocCommands: 0,
			packageIds: ['pkg_media', 'pkg_ops'],
			examples: ['docker restart plex', 'docker ps | grep plex'],
		},
		{
			program: 'ls',
			commands: 1,
			needShell: 0,
			adHocCommands: 1,
			packageIds: [],
			examples: ['ls /volume1'],
		},
	])
	expect(summary.morePrograms).toBe(0)
})

test('only the 20 most used programs are listed, and the rest are counted', () => {
	const uses = Array.from({ length: 23 }, (_, index) => ({
		at: '2026-11-01',
		command: `tool${index}`,
		entryPackageIds: [],
	}))
	const summary = summarizeShellUse(uses)
	expect(summary.programs).toHaveLength(20)
	expect(summary.morePrograms).toBe(3)
})

test('quoted text is literal, except substitution inside double quotes', () => {
	expect(commandNeedsShell("echo 'ready?'")).toBe(false)
	expect(commandNeedsShell('grep "a|b" notes.txt')).toBe(false)
	expect(commandNeedsShell('echo "it\\"s; fine"')).toBe(false)
	expect(commandNeedsShell('echo "$HOME"')).toBe(true)
	expect(commandNeedsShell('echo "`date`"')).toBe(true)
	expect(commandNeedsShell("echo 'a' | wc")).toBe(true)
	expect(commandNeedsShell('ls *.txt')).toBe(true)
})
