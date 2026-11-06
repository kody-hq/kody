import { describe, expect, it } from 'vitest'
import { rankCommands, parseCommandQuery, type Command } from './model.ts'
const commands: Command[] = [
	{
		id: 'jobs',
		title: 'Jobs',
		kind: 'page',
		icon: 'briefcase',
		keywords: 'schedule automation',
	},
	{ id: 'repo', title: 'Jobs dashboard', kind: 'repository', icon: 'box' },
	{ id: 'billing', title: 'Billing', kind: 'page', icon: 'wallet' },
	{ id: 'run', title: 'Run nightly backup', kind: 'action', icon: 'play' },
]
describe('command ranking', () => {
	it('puts an exact match ahead of a frequently used fuzzy match', () => {
		expect(
			rankCommands(
				commands,
				'jobs',
				{ repo: { count: 100, lastUsed: 100, pinned: true } },
				100,
			)[0]?.id,
		).toBe('jobs')
	})
	it('finds abbreviations and aliases and requires every query token', () => {
		expect(rankCommands(commands, 'jb', {}).map((item) => item.id)).toEqual([
			'jobs',
			'repo',
		])
		expect(rankCommands(commands, 'automation', {})[0]?.id).toBe('jobs')
		expect(rankCommands(commands, 'nightly backup', {})[0]?.id).toBe('run')
		expect(rankCommands(commands, 'nightly billing', {})).toEqual([])
	})
	it('filters resource types and command mode', () => {
		expect(
			rankCommands(commands, 'repo: jobs', {}).map((item) => item.id),
		).toEqual(['repo'])
		expect(rankCommands(commands, '> jobs', {}).map((item) => item.id)).toEqual(
			['jobs'],
		)
		expect(parseCommandQuery('memory: café')).toEqual({
			text: 'café',
			kind: 'memory',
			commandsOnly: false,
		})
	})
	it('uses favorites and recent use without surfacing unrelated results', () => {
		const history = { billing: { count: 3, lastUsed: 100, pinned: true } }
		expect(rankCommands(commands, '', history, 100)[0]?.id).toBe('billing')
		expect(
			rankCommands(commands, 'nightly', history, 100).map((item) => item.id),
		).toEqual(['run'])
	})
})
