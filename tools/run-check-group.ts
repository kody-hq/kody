/**
 * Run every check in a named group. Continues after a failure so one
 * member does not hide the next. Exits non-zero when any member failed.
 *
 * Usage: node tools/run-check-group.ts <docs|deps>
 */

import { spawn } from 'node:child_process'
import { resolveNpmCommand, isExecutedDirectly } from './node-runtime.ts'

export type CheckGroupMember = {
	name: string
	/** npm script name (kept while per-check scripts still exist). */
	script: string
}

export const checkGroups = {
	docs: [
		{ name: 'docs:check-temporal', script: 'docs:check-temporal' },
		{ name: 'docs:check-decisions', script: 'docs:check-decisions' },
		{ name: 'docs:check-file-refs', script: 'docs:check-file-refs' },
		{
			name: 'docs:check-no-hosted-execute',
			script: 'docs:check-no-hosted-execute',
		},
		{ name: 'mermaid:check', script: 'mermaid:check' },
	],
	deps: [
		{ name: 'lockfile:check', script: 'lockfile:check' },
		{ name: 'overrides:check', script: 'overrides:check' },
		{ name: 'skills-lock:check', script: 'skills-lock:check' },
	],
} as const satisfies Record<string, readonly CheckGroupMember[]>

export type CheckGroupName = keyof typeof checkGroups

export function isCheckGroupName(value: string): value is CheckGroupName {
	return Object.hasOwn(checkGroups, value)
}

export function runNpmScript(
	script: string,
	options: {
		spawnImpl?: typeof spawn
		cwd?: string
		env?: NodeJS.ProcessEnv
	} = {},
): Promise<number> {
	const spawnImpl = options.spawnImpl ?? spawn
	return new Promise((resolve, reject) => {
		const child = spawnImpl(resolveNpmCommand(), ['run', script], {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: 'inherit',
		})
		child.once('error', reject)
		child.once('close', (code) => {
			resolve(code ?? 1)
		})
	})
}

export async function runCheckGroup(
	groupName: CheckGroupName,
	options: {
		log?: (line: string) => void
		runMember?: (member: CheckGroupMember) => Promise<number>
	} = {},
): Promise<{ ok: boolean; failed: string[] }> {
	const log = options.log ?? ((line) => console.log(line))
	const runMember =
		options.runMember ?? ((member) => runNpmScript(member.script))
	const members = checkGroups[groupName]
	const failed: string[] = []
	for (const member of members) {
		log(`${groupName}: running ${member.name}`)
		const code = await runMember(member)
		if (code !== 0) {
			failed.push(member.name)
			log(`${groupName}: ${member.name} failed (exit ${String(code)})`)
		} else {
			log(`${groupName}: ${member.name} passed`)
		}
	}
	if (failed.length > 0) {
		log(`${groupName}: failed checks: ${failed.join(', ')}`)
		return { ok: false, failed }
	}
	log(`${groupName}: all ${String(members.length)} checks passed`)
	return { ok: true, failed: [] }
}

async function main() {
	const groupArg = process.argv[2]
	if (!groupArg || !isCheckGroupName(groupArg)) {
		const names = Object.keys(checkGroups).join('|')
		console.error(`Usage: node tools/run-check-group.ts <${names}>`)
		process.exitCode = 1
		return
	}
	const result = await runCheckGroup(groupArg)
	if (!result.ok) process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
