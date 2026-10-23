import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	checkSkillsLock,
	shipPrLockSource,
	skillsLockRelativePath,
} from './check-skills-lock.ts'

const fixtureSkill = 'name: ship-pr\n'
// Independent of computeSkillFolderHash: SHA-256("SKILL.md" utf-8 || file bytes).
const fixtureFolderHash =
	'bc93b3d2b7adf2a581c6eac6872e4254f795752fcde8f6111827fc0c1f2eb773'

test('skills lock requires a repo-owned ship-pr whose folder hash matches', async () => {
	const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'skills-lock-'))
	try {
		const skillDir = path.join(repoRoot, '.agents', 'skills', 'ship-pr')
		await mkdir(skillDir, { recursive: true })
		await writeFile(path.join(skillDir, 'SKILL.md'), fixtureSkill)

		await writeLock(repoRoot, {
			source: 'kentcdodds/kcd-skills',
			sourceType: 'github',
			skillPath: 'skills/ship-pr/SKILL.md',
			computedHash: fixtureFolderHash,
		})
		const upstreamOwned = await checkSkillsLock(repoRoot)
		expect(upstreamOwned.ok).toBe(false)
		expect(upstreamOwned.errors.join('\n')).toContain(shipPrLockSource)
		expect(upstreamOwned.errors.join('\n')).toContain('kentcdodds/kcd-skills')

		await writeLock(repoRoot, {
			source: shipPrLockSource,
			sourceType: 'local',
			computedHash: 'deadbeef',
		})
		const drifted = await checkSkillsLock(repoRoot)
		expect(drifted.ok).toBe(false)
		expect(drifted.errors.join('\n')).toContain('deadbeef')
		expect(drifted.errors.join('\n')).toContain(fixtureFolderHash)

		await writeLock(repoRoot, {
			source: shipPrLockSource,
			sourceType: 'local',
			skillPath: 'SKILL.md',
			computedHash: fixtureFolderHash,
		})
		const stillUpstreamShaped = await checkSkillsLock(repoRoot)
		expect(stillUpstreamShaped.ok).toBe(false)
		expect(stillUpstreamShaped.errors.join('\n')).toContain('skillPath')

		await writeLock(repoRoot, {
			source: shipPrLockSource,
			sourceType: 'local',
			computedHash: fixtureFolderHash,
		})
		expect(await checkSkillsLock(repoRoot)).toEqual({ ok: true, errors: [] })
	} finally {
		await rm(repoRoot, { recursive: true, force: true })
	}
})

async function writeLock(
	repoRoot: string,
	shipPr: {
		source: string
		sourceType: string
		computedHash: string
		skillPath?: string
	},
) {
	await writeFile(
		path.join(repoRoot, skillsLockRelativePath),
		`${JSON.stringify({ version: 1, skills: { 'ship-pr': shipPr } }, null, 2)}\n`,
	)
}
