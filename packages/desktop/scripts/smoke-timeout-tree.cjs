#!/usr/bin/env node
/**
 * Synthetic check for Desktop release runners: a SIGTERM-resistant descendant
 * under run-with-timeout must die (via process-group SIGKILL) before retry.
 */
const { spawnSync } = require('node:child_process')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const helper = join(__dirname, 'run-with-timeout.cjs')
const dir = mkdtempSync(join(tmpdir(), 'kody-timeout-tree-'))
const pidFile = join(dir, 'grandchild.pid')

try {
	writeFileSync(pidFile, '')
	const script = [
		'( trap "" TERM; exec sleep 60 ) &',
		`echo $! > ${JSON.stringify(pidFile)}`,
		'sleep 30',
	].join('\n')
	const result = spawnSync(
		process.execPath,
		[helper, '1s', 'bash', '-c', script],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
	)
	if (result.status !== 124) {
		process.stderr.write(
			`expected exit 124 from run-with-timeout, got ${result.status}\n${result.stdout}${result.stderr}`,
		)
		process.exitCode = 1
		return
	}
	const raw = readFileSync(pidFile, 'utf8').trim()
	const pid = Number(raw)
	if (!Number.isInteger(pid) || pid <= 0) {
		process.stderr.write(`missing grandchild pid in ${pidFile}\n`)
		process.exitCode = 1
		return
	}
	try {
		process.kill(pid, 0)
		process.stderr.write(
			`SIGTERM-resistant grandchild ${pid} still alive after timeout\n`,
		)
		try {
			process.kill(pid, 'SIGKILL')
		} catch {
			/* ignore */
		}
		process.exitCode = 1
		return
	} catch {
		process.stdout.write(
			`ok: timed-out tree stopped resistant grandchild ${pid} on ${process.platform} ${process.arch}\n`,
		)
	}
} finally {
	rmSync(dir, { recursive: true, force: true })
}
