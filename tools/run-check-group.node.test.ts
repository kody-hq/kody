import { expect, test } from 'vitest'
import { runCheckGroup } from './run-check-group.ts'

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
		'npm-floor:check',
	])
	expect(lines.at(-1)).toBe('deps: failed checks: overrides:check')
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
		'npm-floor:check',
	])
	expect(lines).toContain('deps: lockfile:check failed (spawn npm ENOENT)')
	expect(lines.at(-1)).toBe('deps: failed checks: lockfile:check')
})
