/**
 * Run every check in a named group. Continues after a failure so one
 * member does not hide the next. Exits non-zero when any member failed.
 *
 * Usage: node tools/run-check-group.ts <docs|deps>
 */

import { spawn } from 'node:child_process'
import { isExecutedDirectly } from './node-runtime.ts'

export type CheckGroupMember = {
	/** Stable name used in failure summaries. */
	name: string
	/** Repo-relative path passed to `node` (no npm script indirection). */
	tool: string
}

export const checkGroups = {
	docs: [
		{
			name: 'docs:check-temporal',
			tool: 'tools/check-docs-temporal-language.ts',
		},
		{
			name: 'docs:check-decisions',
			tool: 'tools/check-decision-record-numbers.ts',
		},
		{
			name: 'docs:check-file-refs',
			tool: 'tools/check-markdown-file-refs.ts',
		},
		{
			name: 'docs:check-no-hosted-execute',
			tool: 'tools/check-docs-no-hosted-execute.ts',
		},
		{ name: 'mermaid:check', tool: 'tools/check-mermaid-syntax.ts' },
	],
	deps: [
		{ name: 'lockfile:check', tool: 'tools/check-lockfile-peer-drift.ts' },
		{
			name: 'overrides:check',
			tool: 'tools/check-dependency-overrides.ts',
		},
		{ name: 'skills-lock:check', tool: 'tools/check-skills-lock.ts' },
	],
} as const satisfies Record<string, readonly CheckGroupMember[]>

export type CheckGroupName = keyof typeof checkGroups

export function isCheckGroupName(value: string): value is CheckGroupName {
	return Object.hasOwn(checkGroups, value)
}

export function runNodeTool(
	tool: string,
	options: {
		spawnImpl?: typeof spawn
		cwd?: string
		env?: NodeJS.ProcessEnv
	} = {},
): Promise<number> {
	const spawnImpl = options.spawnImpl ?? spawn
	return new Promise((resolve, reject) => {
		const child = spawnImpl(process.execPath, [tool], {
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
	const runMember = options.runMember ?? ((member) => runNodeTool(member.tool))
	const members = checkGroups[groupName]
	const failed: string[] = []
	for (const member of members) {
		log(`${groupName}: running ${member.name}`)
		let code: number
		try {
			code = await runMember(member)
		} catch (error) {
			failed.push(member.name)
			const detail = error instanceof Error ? error.message : String(error)
			log(`${groupName}: ${member.name} failed (${detail})`)
			continue
		}
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
