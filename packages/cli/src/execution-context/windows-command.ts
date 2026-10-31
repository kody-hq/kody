import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { win32 } from 'node:path'

/**
 * Windows launch rules for host commands (ADR 0092): PowerShell by default
 * (`pwsh`, else Windows PowerShell), `cmd` on request, UTF-8 output, and
 * `.cmd`/`.bat` files run through `cmd.exe` with cross-spawn's quoting because
 * Node refuses to spawn them directly.
 */

export type WindowsShell = 'powershell' | 'cmd'

export type WindowsLaunch = {
	file: string
	argv: Array<string>
	/** Pass argv to CreateProcess as-is (we quoted it for cmd.exe). */
	verbatim: boolean
}

type FileExists = (path: string) => boolean

const isFile: FileExists = (path) => {
	try {
		return statSync(path).isFile()
	} catch {
		return false
	}
}

/** Case-insensitive env read: Windows env keys are case-insensitive. */
export function windowsEnv(env: NodeJS.ProcessEnv, name: string) {
	const key = Object.keys(env).find(
		(candidate) => candidate.toUpperCase() === name.toUpperCase(),
	)
	return key === undefined ? undefined : env[key]
}

function pathExts(env: NodeJS.ProcessEnv) {
	return (windowsEnv(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
		.split(';')
		.map((ext) => ext.trim().toLowerCase())
		.filter(Boolean)
}

/** Resolves a command name the way cmd.exe does: PATH x PATHEXT. */
export function resolveWindowsExecutable(
	file: string,
	env: NodeJS.ProcessEnv,
	exists: FileExists = isFile,
): string | null {
	const exts = win32.extname(file) ? [''] : pathExts(env)
	const hasDir = /[\\/]/.test(file) || win32.isAbsolute(file)
	const dirs = hasDir
		? ['']
		: (windowsEnv(env, 'PATH') ?? '').split(';').filter(Boolean)
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = dir ? win32.join(dir, file + ext) : file + ext
			if (exists(candidate)) return candidate
		}
	}
	return null
}

const metaChars = /([()\][%!^"`<>&|;, *?])/g

function escapeCmdCommand(value: string) {
	return value.replace(metaChars, '^$1')
}

/** cross-spawn's argument escaping for `cmd.exe /d /s /c "..."`. */
export function escapeCmdArgument(value: string, doubleEscape: boolean) {
	let arg = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
	arg = arg.replace(/(?=(\\+?)?)\1$/, '$1$1')
	arg = `"${arg}"`.replace(metaChars, '^$1')
	return doubleEscape ? arg.replace(metaChars, '^$1') : arg
}

function cmdExe(env: NodeJS.ProcessEnv) {
	return windowsEnv(env, 'ComSpec') || 'cmd.exe'
}

export function powershellExe(
	env: NodeJS.ProcessEnv,
	exists: FileExists = isFile,
) {
	const pwsh = resolveWindowsExecutable('pwsh.exe', env, exists)
	if (pwsh) return pwsh
	const root = windowsEnv(env, 'SystemRoot') || 'C:\\Windows'
	const builtIn = win32.join(
		root,
		'System32',
		'WindowsPowerShell',
		'v1.0',
		'powershell.exe',
	)
	return exists(builtIn) ? builtIn : 'powershell.exe'
}

const utf8Prelude =
	'$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/** How a shell command line launches on Windows. */
export function windowsShellLaunch(
	command: string,
	shell: WindowsShell,
	env: NodeJS.ProcessEnv,
	exists: FileExists = isFile,
): WindowsLaunch {
	if (shell === 'cmd') {
		// chcp 65001 switches the console code page so output is UTF-8.
		return {
			file: cmdExe(env),
			argv: ['/d', '/s', '/c', `"chcp 65001 >nul & ${command}"`],
			verbatim: true,
		}
	}
	return {
		file: powershellExe(env, exists),
		argv: [
			'-NoLogo',
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			utf8Prelude + command,
		],
		verbatim: false,
	}
}

/** How `{ file, args }` launches on Windows, resolving `.cmd`/`.bat` explicitly. */
export function windowsFileLaunch(
	file: string,
	args: Array<string>,
	env: NodeJS.ProcessEnv,
	exists: FileExists = isFile,
): WindowsLaunch {
	const resolved = resolveWindowsExecutable(file, env, exists) ?? file
	if (!/\.(cmd|bat)$/i.test(resolved)) {
		return { file: resolved, argv: args, verbatim: false }
	}
	const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(
		resolved,
	)
	const line = [
		escapeCmdCommand(win32.normalize(resolved)),
		...args.map((arg) => escapeCmdArgument(arg, doubleEscape)),
	].join(' ')
	return {
		file: cmdExe(env),
		argv: ['/d', '/s', '/c', `"${line}"`],
		verbatim: true,
	}
}

/**
 * Kills a Windows process and every descendant (`taskkill /T /F`). Once the
 * leader has exited taskkill cannot walk from it, so descendants are found by
 * their recorded ParentProcessId instead.
 */
export function killWindowsTree(
	pid: number,
	options: { leaderExited?: boolean } = {},
) {
	const root = Math.trunc(pid)
	const killer = options.leaderExited
		? spawn(
				'powershell.exe',
				[
					'-NoLogo',
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					orphanSweep(root),
				],
				{ stdio: 'ignore', windowsHide: true },
			)
		: spawn('taskkill.exe', ['/PID', String(root), '/T', '/F'], {
				stdio: 'ignore',
				windowsHide: true,
			})
	killer.on('error', () => {})
	return new Promise<void>((resolve) => killer.once('close', () => resolve()))
}

function orphanSweep(root: number) {
	return [
		'$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)',
		`$seen = @{ ${root} = $true }`,
		'$todo = [System.Collections.Generic.Queue[int]]::new()',
		`$todo.Enqueue(${root})`,
		'while ($todo.Count) {',
		'  $parent = $todo.Dequeue()',
		'  foreach ($p in $all) {',
		'    if ($p.ParentProcessId -eq $parent -and -not $seen.ContainsKey([int]$p.ProcessId)) {',
		'      $seen[[int]$p.ProcessId] = $true',
		'      $todo.Enqueue([int]$p.ProcessId)',
		'      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue',
		'    }',
		'  }',
		'}',
	].join('\n')
}
