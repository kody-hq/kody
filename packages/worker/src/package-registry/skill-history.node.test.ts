import { expect, test } from 'vitest'
import { planSkillRestore } from './skill-history.ts'

test('restores the whole selected skill without touching other package files', () => {
	const plan = planSkillRestore({
		name: 'writing',
		current: {
			'skills/writing/SKILL.md': 'new',
			'skills/writing/extra.md': 'new file',
			'skills/other/SKILL.md': 'keep',
			'package.json': 'keep',
		},
		previous: {
			'skills/writing/SKILL.md': 'old',
			'skills/writing/icon.png': '\u0089PNG\u0000\u00ff',
			'skills/other/SKILL.md': 'old other',
			'package.json': 'old package',
		},
	})
	expect(plan).toEqual({
		writes: [
			['skills/writing/SKILL.md', 'old'],
			['skills/writing/icon.png', '\u0089PNG\u0000\u00ff'],
		],
		deletes: ['skills/writing/extra.md'],
	})
})

test('rejects traversal and versions without instructions before planning any writes', () => {
	expect(() =>
		planSkillRestore({ name: '../other', current: {}, previous: {} }),
	).toThrow('Invalid skill name')
	expect(() =>
		planSkillRestore({ name: 'writing', current: {}, previous: {} }),
	).toThrow('does not contain')
	const plan = planSkillRestore({
		name: 'writing',
		current: {},
		previous: {
			'skills/writing/SKILL.md': 'ok',
			'skills/writing/../../package.json': 'bad',
			'skills/writing-extra/SKILL.md': 'not this skill',
		},
	})
	expect(plan.writes).toEqual([['skills/writing/SKILL.md', 'ok']])
})
