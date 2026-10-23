import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
	installSkill,
	projectSkillTargets,
	userSkillTargets,
} from '../src/skill.js'

const sourcePath = fileURLToPath(
	new URL('../skills/kody/SKILL.md', import.meta.url),
)

test('installSkill writes the bundled skill to user host directories', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-skill-home-'))
	const targets = await installSkill({ home, sourcePath })
	assert.equal(targets.length, userSkillTargets(home).length)
	for (const target of targets) {
		assert.equal(
			readFileSync(target.path, 'utf8'),
			readFileSync(sourcePath, 'utf8'),
		)
	}
})

test('installSkill --project writes into the current workspace', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'kody-skill-project-'))
	const targets = await installSkill({ project: true, cwd, sourcePath })
	assert.deepEqual(
		targets.map((target) => target.path),
		projectSkillTargets(cwd).map((target) => target.path),
	)
})
