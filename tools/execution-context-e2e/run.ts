/**
 * End-to-end execution context check against a PR preview (never production):
 * register a throwaway context, run the daemon, execute on it with a host
 * folder and a host command, run a workflow step on it, stop the daemon,
 * assert no workerd is left, then revoke and delete.
 * See docs/contributing/execution-context-e2e.md.
 */
import { execFileSync, fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openRehearsalSession } from '../preview-rehearsal/kody-session.ts'
import {
	callCapability,
	mintCliToken,
	readStringAt,
} from '../preview-rehearsal/cli-token.ts'
import { shouldRetryExecutionContextCli } from './retry.ts'

const appOrigin = (process.env.PREVIEW_ORIGIN ?? '').replace(/\/+$/, '')
const { protocol, hostname: host } = new URL(appOrigin || 'https://invalid')
if (
	protocol !== 'https:' ||
	!/^kody-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(host)
)
	throw new Error(
		`PREVIEW_ORIGIN must be an https kody preview on workers.dev (got ${JSON.stringify(appOrigin)}). Production is never allowed.`,
	)
const apiOrigin = appOrigin.replace(/^(https:\/\/[^.]+)\./, '$1-api.')
const root = join(import.meta.dirname, '..', '..')
const cliEntry = join(root, 'packages', 'cli', 'dist', 'bin.js')
const label = `${process.platform}-${process.arch}-${process.env.GITHUB_RUN_ID ?? Date.now()}`
const name = `e2e-${label}`
	.toLowerCase()
	.replace(/[^a-z0-9-]/g, '-')
	.slice(0, 63)

const home = mkdtempSync(join(tmpdir(), 'kody-ec-e2e-home-'))
const folder = mkdtempSync(join(tmpdir(), 'kody-ec-e2e-folder-'))
const log = (line: string) => process.stdout.write(`[ec-e2e] ${line}\n`)

function cliEnv(token: string) {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		APPDATA: join(home, 'AppData', 'Roaming'),
		XDG_CONFIG_HOME: join(home, '.config'),
		XDG_STATE_HOME: join(home, '.local', 'state'),
		KODY_API_URL: apiOrigin,
		KODY_API_TOKEN: token,
		KODY_CONTEXT_KEY_PASSPHRASE: `e2e-${crypto.randomUUID()}`,
		// Previews sign key sets with the public test root (test only).
		KODY_ECP_TRUST_TEST_ROOT: '1',
		KODY_SKIP_SKILL_REFRESH: '1',
		KODY_SKIP_GIT_HELPER_REFRESH: '1',
	}
	return env
}

const cliRetryDelayMs = 2_000

function runCli(env: NodeJS.ProcessEnv, args: Array<string>) {
	return execFileSync(process.execPath, [cliEntry, ...args], {
		env,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
		windowsHide: true,
		timeout: 180_000,
	})
}

async function cli(env: NodeJS.ProcessEnv, args: Array<string>) {
	try {
		return runCli(env, args)
	} catch (error) {
		if (!shouldRetryExecutionContextCli(error, args)) throw error
		log(`retrying ${args.join(' ')} after a transient API fetch failure`)
		await delay(cliRetryDelayMs)
		return runCli(env, args)
	}
}

function workerdProcesses() {
	if (process.platform === 'win32') {
		const out = execFileSync(
			'tasklist.exe',
			['/FI', 'IMAGENAME eq workerd.exe', '/FO', 'CSV', '/NH'],
			{ encoding: 'utf8', windowsHide: true },
		)
		return out.split(/\r?\n/).filter((line) => /workerd\.exe/i.test(line))
	}
	try {
		return execFileSync('pgrep', ['-fl', 'workerd'], { encoding: 'utf8' })
			.split('\n')
			.filter((line) => line.trim() && !line.includes('pgrep'))
	} catch {
		return []
	}
}

const shellMarker = 'kody-ec-e2e-shell'
// Windows runs PowerShell by default; macOS and Linux run $SHELL.
const shellCommand =
	process.platform === 'win32'
		? `"${shellMarker}|$($PSVersionTable.PSEdition)|$((Get-Location).Path)"`
		: `printf '%s|%s' ${shellMarker} "$(pwd)"`

function findShellResult(
	value: unknown,
): { exitCode?: number; stdout?: string } | null {
	if (!value || typeof value !== 'object') return null
	const record = value as Record<string, unknown>
	if (record.shell && typeof record.shell === 'object')
		return record.shell as { exitCode?: number; stdout?: string }
	for (const child of Object.values(record)) {
		const hit = findShellResult(child)
		if (hit) return hit
	}
	return null
}

type RehearsalSession = Awaited<ReturnType<typeof openRehearsalSession>>

// `workflows.create` with `execution` (ADR 0086): the step runs a package
// export on the context, so it reads the host folder.
async function runWorkflowStepOnContext(session: RehearsalSession) {
	writeFileSync(join(folder, 'workflow.txt'), 'read by the workflow step')
	const packageJson = {
		name: `@user-me/${name.slice(0, 50)}-wf`,
		version: '1.0.0',
		description: 'Execution context e2e workflow step',
		exports: { './on-context': './src/on-context.ts' },
		kody: { description: 'Execution context e2e workflow step' },
	}
	const saved = await callCapability(session, 'packageSave', {
		files: [
			{
				path: 'package.json',
				content: `${JSON.stringify(packageJson, null, 2)}\n`,
			},
			{
				path: 'README.md',
				content:
					'# Execution context e2e workflow step\n\nReads a host folder file from a workflow step on an execution context. Created and deleted by the e2e.\n',
			},
			{
				path: 'AGENTS.md',
				content:
					'# Agents\n\nThrowaway package for `tools/execution-context-e2e/run.ts`. `./on-context` takes `{ folder }` and returns `{ read }`.\n',
			},
			{
				path: 'src/on-context.ts',
				content: `import { readFile } from 'node:fs/promises'
export default async function onContext(params) {
	const sep = params.folder.includes('\\\\') ? '\\\\' : '/'
	return { read: await readFile(params.folder + sep + 'workflow.txt', 'utf8') }
}
`,
			},
		],
	})
	const packageId = readStringAt(saved, ['package_id'], 'packageSave')
	const created = await session.execute(
		`import { workflows } from 'kody:runtime'
export default async function main(params) {
	return await workflows.create(params)
}
`,
		{
			exportName: './on-context',
			packageId,
			params: { folder },
			execution: { context: name },
		},
	)
	const workflowId = readStringAt(created, ['id'], 'workflows.create')
	log(`workflow ${workflowId} created on ${name}`)
	const deadline = Date.now() + 180_000
	for (;;) {
		const listed = (await session.api('runList', {
			workflow_id: workflowId,
			error_triage: 'all',
		})) as {
			runs?: Array<{
				status?: string
				error_message?: string | null
				metadata?: { result?: unknown }
			}>
		}
		const run = listed?.runs?.[0]
		if (run?.status === 'success') {
			if (
				!JSON.stringify(run.metadata?.result).includes('read by the workflow')
			)
				throw new Error(
					`The workflow step did not read the host folder: ${JSON.stringify(run.metadata?.result)}`,
				)
			break
		}
		// A failed attempt can still be retried, so only a terminal workflow
		// status ends the wait.
		if (run?.status === 'error') {
			const workflow = (await session.api('workflowRunList', {
				workflow_id: workflowId,
			})) as { workflows?: Array<{ status?: string | null }> }
			const status = workflow?.workflows?.[0]?.status
			if (status === 'errored' || status === 'terminated')
				throw new Error(`The workflow step failed: ${run.error_message}`)
		}
		if (Date.now() > deadline)
			throw new Error(
				`The workflow step never finished: ${JSON.stringify(listed)}`,
			)
		await delay(3000)
	}
	log(`workflow step ran on ${name}`)
	await callCapability(session, 'packageDelete', {
		package_id: packageId,
		confirm_name: packageJson.name,
	}).catch((error: Error) => log(`package delete failed: ${error.message}`))
}

async function main() {
	// With `preview-seed:team-org` the seed user is in two orgs and OAuth makes
	// it pick one; the context lives in the personal org.
	const session = await openRehearsalSession(
		appOrigin,
		{ email: 'me@kentcdodds.com', username: 'user-me', password: 'ilikecode' },
		{ orgSlug: 'user-me' },
	)
	let ecid: string | null = null
	try {
		const token = await mintCliToken(
			session,
			{ app: appOrigin, api: apiOrigin, mockCloudflare: '' },
			`ec-e2e-${label}`,
			{ lifetime: 'short' },
		)
		const env = cliEnv(token)
		const registered = JSON.parse(
			await cli(env, [
				'context',
				'register',
				'--name',
				name,
				'--json',
				'--no-install',
			]),
		) as { ecid: string }
		ecid = registered.ecid
		log(`registered ${name} (${ecid})`)
		await cli(env, ['context', 'policy', 'allow', folder, '--mode', 'rw'])
		await session.api('executionContextUpdate', {
			id: ecid,
			grant: { fs: [{ path: folder, mode: 'rw' }] },
		})
		await cli(env, ['context', 'commands', 'on', '--context', name, '--json'])
		log('host commands turned on locally')

		const daemon = fork(
			join(import.meta.dirname, 'daemon-host.cjs'),
			['daemon', '--context', ecid, '--api-url', apiOrigin],
			{ env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
		)
		const exited = once(daemon, 'exit')
		const deadline = Date.now() + 180_000
		for (;;) {
			const got = (await session.api('executionContextGet', { id: ecid })) as {
				context?: { status?: string; acceptingRuns?: boolean }
			}
			if (got?.context?.status === 'online' && got.context.acceptingRuns) break
			if (Date.now() > deadline)
				throw new Error('The daemon never came online.')
			await delay(2000)
		}
		log('daemon online')

		writeFileSync(join(folder, 'seed.txt'), 'from the host')
		const module = join(home, 'module.ts')
		writeFileSync(
			module,
			`import { readFile, writeFile } from 'node:fs/promises'
import { kody } from 'kody:runtime'
export default async function main() {
	const folder = ${JSON.stringify(folder)}
	const sep = folder.includes('\\\\') ? '\\\\' : '/'
	const seed = await readFile(folder + sep + 'seed.txt', 'utf8')
	await writeFile(folder + sep + 'from-run.txt', 'written by the run')
	const shell = await kody.command.run({
		command: ${JSON.stringify(shellCommand)},
		cwd: folder,
	})
	return { seed, sum: 20 + 22, shell }
}
`,
		)
		const output = await cli(env, [
			'execute',
			'--file',
			module,
			'--context',
			name,
			'--json',
		])
		log(`execute: ${output.trim().slice(0, 400)}`)
		if (!output.includes('from the host') || !output.includes('42'))
			throw new Error('The run did not return the host folder read.')
		if (
			readFileSync(join(folder, 'from-run.txt'), 'utf8') !==
			'written by the run'
		)
			throw new Error('The run did not write into the host folder.')
		log(`host folder read/write ok on ${process.platform}`)
		const shell = findShellResult(JSON.parse(output.slice(output.indexOf('{'))))
		if (shell?.exitCode !== 0 || !shell.stdout?.includes(shellMarker))
			throw new Error(`The host command did not run: ${JSON.stringify(shell)}`)
		log(`host command ok on ${process.platform}`)

		await runWorkflowStepOnContext(session)

		daemon.send('stop')
		const [code] = await Promise.race([
			exited,
			delay(30_000).then(() => {
				throw new Error('The daemon did not stop within 30s.')
			}),
		])
		log(`daemon stopped (exit ${code})`)
		await delay(1000)
		const left = workerdProcesses()
		if (left.length > 0)
			throw new Error(
				`workerd is still running after stop:\n${left.join('\n')}`,
			)
		log('no workerd left')
	} finally {
		if (ecid) {
			await session
				.api('executionContextRevoke', { id: ecid })
				.catch((error) => log(`revoke failed: ${error.message}`))
			await session
				.api('executionContextDelete', { id: ecid })
				.catch((error) => log(`delete failed: ${error.message}`))
			log('revoked and deleted the context')
		}
		await session.close()
		rmSync(home, { recursive: true, force: true })
		rmSync(folder, { recursive: true, force: true })
	}
}

await main()
