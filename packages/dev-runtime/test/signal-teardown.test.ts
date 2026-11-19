/**
 * A host that tears the runtime down on a signal must leave no wrangler or
 * workerd behind: the next start has to get its ports back.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const distDir = fileURLToPath(new URL('../dist', import.meta.url))
const entry = join(distDir, 'index.js')
const skip =
	process.platform === 'win32'
		? 'process groups are POSIX only'
		: !existsSync(entry)
			? 'run `npm run build -w @kodycodes/dev-runtime` first'
			: false

const host = `
import { startDevRuntime } from ${JSON.stringify(entry)}
const kody = await startDevRuntime({ stateDir: process.argv[1], username: 'signals' })
const stop = async () => {
	await kody.close()
	process.exit(0)
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stop)
process.stdout.write(JSON.stringify({ port: new URL(kody.origin).port }) + '\\n')
`

function descendants(root: number): Array<number> {
	const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
		encoding: 'utf8',
	})
		.trim()
		.split('\n')
		.map((row) => row.trim().split(/\s+/).map(Number))
	const found: Array<number> = []
	const queue = [root]
	while (queue.length > 0) {
		const parent = queue.shift()
		for (const [pid, ppid] of rows) {
			if (ppid === parent && pid !== undefined) {
				found.push(pid)
				queue.push(pid)
			}
		}
	}
	return found
}

function alive(pid: number) {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

function portFree(port: number) {
	return new Promise<boolean>((done) => {
		const server = createServer()
		server.once('error', () => done(false))
		server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
	})
}

for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
	test(
		`${signal} tears down every runtime child process`,
		{ skip, timeout: 240_000 },
		async () => {
			const stateDir = await mkdtemp(join(tmpdir(), 'kody-dev-signal-'))
			const child = spawn(
				process.execPath,
				['--input-type=module', '-e', host, stateDir],
				{ stdio: ['ignore', 'pipe', 'inherit'] },
			)
			try {
				const { port } = await new Promise<{ port: string }>((done, fail) => {
					let out = ''
					child.stdout.on('data', (chunk: Buffer) => {
						out += chunk.toString('utf8')
						const line = out.split('\n').find((l) => l.startsWith('{'))
						if (line) done(JSON.parse(line))
					})
					child.once('exit', (code) =>
						fail(new Error(`runtime host exited early (${code})`)),
					)
				})
				const tree = descendants(child.pid!)
				assert.ok(tree.length > 0, 'runtime started child processes')
				const exited = new Promise((done) => child.once('exit', done))
				process.kill(child.pid!, signal)
				await exited
				await new Promise((done) => setTimeout(done, 500))
				assert.deepEqual(tree.filter(alive), [], 'no child process survived')
				assert.equal(await portFree(Number(port)), true, 'origin port released')
			} finally {
				if (child.exitCode === null) child.kill('SIGKILL')
				await rm(stateDir, { recursive: true, force: true })
			}
		},
	)
}
