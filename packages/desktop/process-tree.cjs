const { execFile } = require('node:child_process')

// PowerShell + CIM cold start takes over 15s on Windows on Arm runners.
const hidden = { windowsHide: true, timeout: 60_000 }

// Windows has no process groups. While the CLI is alive, taskkill walks its
// tree; once it is gone its orphans still name it as their parent, so match
// on that plus a creation time after the CLI started (PIDs are reused).
// `alive`: taskkill only while the tracked child still runs; after its exit
// the PID may already belong to an unrelated process.
function killWindowsTree(pid, startedAt, done = () => {}, alive = true) {
	const since = Math.max(0, Math.trunc(startedAt) - 1000)
	const script = [
		`$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${since}).UtcDateTime`,
		'$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate)',
		`$parents = @(${Math.trunc(pid)}); $kill = @()`,
		'while ($parents.Count -gt 0) {',
		'  $next = @($all | Where-Object { $parents -contains $_.ParentProcessId -and $_.CreationDate.ToUniversalTime() -ge $since -and $kill -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId })',
		'  $kill += $next; $parents = $next',
		'}',
		'foreach ($id in $kill) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }',
	].join('\n')
	const sweep = () =>
		execFile(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-Command', script],
			hidden,
			() => done(),
		)
	if (!alive) return sweep()
	execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], hidden, sweep)
}

module.exports = { killWindowsTree }
