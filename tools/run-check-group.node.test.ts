import { expect, test } from 'vitest'
import {
	checkGroups,
	isCheckGroupName,
	runCheckGroup,
} from './run-check-group.ts'

test('docs and deps groups list the expected members', () => {
	expect(checkGroups.docs.map((member) => member.name)).toEqual([
		'docs:check-temporal',
		'docs:check-decisions',
		'docs:check-file-refs',
		'docs:check-no-hosted-execute',
		'mermaid:check',
	])
	expect(checkGroups.deps.map((member) => member.name)).toEqual([
		'lockfile:check',
		'overrides:check',
		'skills-lock:check',
	])
})

test('isCheckGroupName accepts only known groups', () => {
	expect(isCheckGroupName('docs')).toBe(true)
	expect(isCheckGroupName('deps')).toBe(true)
	expect(isCheckGroupName('other')).toBe(false)
})

test('runCheckGroup continues after a failure and names every failed member', async () => {
	const lines: Array<string> = []
	const ran: Array<string> = []
	const result = await runCheckGroup('deps', {
		log: (line) => lines.push(line),
		runMember: async (member) => {
			ran.push(member.name)
			return member.name === 'overrides:check' ? 2 : 0
		},
	})
	expect(result).toEqual({ ok: false, failed: ['overrides:check'] })
	expect(ran).toEqual([
		'lockfile:check',
		'overrides:check',
		'skills-lock:check',
	])
	expect(lines.at(-1)).toBe('deps: failed checks: overrides:check')
})

test('runCheckGroup reports success when every member passes', async () => {
	const result = await runCheckGroup('docs', {
		log: () => {},
		runMember: async () => 0,
	})
	expect(result).toEqual({ ok: true, failed: [] })
})

test('runCheckGroup treats a thrown spawn error as a failed member and continues', async () => {
	const lines: Array<string> = []
	const ran: Array<string> = []
	const result = await runCheckGroup('deps', {
		log: (line) => lines.push(line),
		runMember: async (member) => {
			ran.push(member.name)
			if (member.name === 'lockfile:check') {
				throw new Error('spawn npm ENOENT')
			}
			return 0
		},
	})
	expect(result).toEqual({ ok: false, failed: ['lockfile:check'] })
	expect(ran).toEqual([
		'lockfile:check',
		'overrides:check',
		'skills-lock:check',
	])
	expect(lines).toContain('deps: lockfile:check failed (spawn npm ENOENT)')
	expect(lines.at(-1)).toBe('deps: failed checks: lockfile:check')
})

test('docs and deps members point at tools scripts directly', () => {
	for (const member of [...checkGroups.docs, ...checkGroups.deps]) {
		expect(member.tool).toMatch(/^tools\/.+\.ts$/)
	}
})
