import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	escapeCmdArgument,
	powershellExe,
	resolveWindowsExecutable,
	windowsFileLaunch,
	windowsShellLaunch,
} from '../src/execution-context/windows-command.js'

const env = {
	Path: 'C:\\Tools;C:\\Program Files\\PowerShell\\7',
	PATHEXT: '.COM;.EXE;.BAT;.CMD',
	SystemRoot: 'C:\\Windows',
	ComSpec: 'C:\\Windows\\system32\\cmd.exe',
}
const files = new Set(
	[
		'C:\\Tools\\npm.cmd',
		'C:\\Tools\\git.exe',
		'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
		'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
	].map((path) => path.toLowerCase()),
)
const exists = (path: string) => files.has(path.toLowerCase())

test('resolves commands through PATH and PATHEXT (case-insensitive env)', () => {
	assert.equal(
		resolveWindowsExecutable('npm', env, exists),
		'C:\\Tools\\npm.cmd',
	)
	assert.equal(
		resolveWindowsExecutable('git', env, exists),
		'C:\\Tools\\git.exe',
	)
	assert.equal(
		resolveWindowsExecutable('git.exe', env, exists),
		'C:\\Tools\\git.exe',
	)
	assert.equal(resolveWindowsExecutable('missing', env, exists), null)
	assert.equal(
		resolveWindowsExecutable('C:\\Tools\\npm', env, exists),
		'C:\\Tools\\npm.cmd',
	)
})

test('prefers pwsh and falls back to Windows PowerShell', () => {
	assert.equal(
		powershellExe(env, exists),
		'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
	)
	assert.equal(
		powershellExe({ ...env, Path: 'C:\\Tools' }, exists),
		'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
	)
	const launch = windowsShellLaunch('Get-Date', 'powershell', env, exists)
	assert.equal(launch.verbatim, false)
	assert.deepEqual(launch.argv.slice(0, 4), [
		'-NoLogo',
		'-NoProfile',
		'-NonInteractive',
		'-Command',
	])
	assert.match(launch.argv[4]!, /UTF8Encoding.*; Get-Date$/)
})

test('cmd on request runs verbatim with a UTF-8 code page', () => {
	assert.deepEqual(windowsShellLaunch('dir', 'cmd', env, exists), {
		file: 'C:\\Windows\\system32\\cmd.exe',
		argv: ['/d', '/s', '/c', '"chcp 65001 >nul & dir"'],
		verbatim: true,
	})
})

test('.cmd/.bat files run through cmd.exe with escaped args; .exe runs directly', () => {
	assert.deepEqual(windowsFileLaunch('git', ['a b'], env, exists), {
		file: 'C:\\Tools\\git.exe',
		argv: ['a b'],
		verbatim: false,
	})
	const npm = windowsFileLaunch('npm', ['run', 'a&b'], env, exists)
	assert.equal(npm.file, 'C:\\Windows\\system32\\cmd.exe')
	assert.equal(npm.verbatim, true)
	assert.deepEqual(npm.argv, [
		'/d',
		'/s',
		'/c',
		'"C:\\Tools\\npm.cmd ^"run^" ^"a^&b^""',
	])
	assert.equal(escapeCmdArgument('say "hi"', false), '^"say^ \\^"hi\\^"^"')
	assert.equal(escapeCmdArgument('50%', true), '^^^"50^^^%^^^"')
})
