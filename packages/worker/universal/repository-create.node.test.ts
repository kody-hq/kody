import { expect, test } from 'vitest'
import { assertValidUserRepoName } from '#worker/repo/user-repos.ts'
import {
	buildRepositoryStartPrompt,
	repositoryNameError,
} from './repository-create.ts'

test('live name validation matches the repoCreate naming rule', () => {
	const names = [
		'',
		'   ',
		'notes',
		'My-Repo',
		'a',
		'a-b-c',
		'9lives',
		'-lead',
		'trail-',
		'has space',
		'under_score',
		'dot.name',
		'a'.repeat(64),
		'a'.repeat(65),
	]
	for (const name of names) {
		let serverAccepts = true
		try {
			assertValidUserRepoName(name)
		} catch {
			serverAccepts = false
		}
		expect({ name, ok: repositoryNameError(name) === null }).toEqual({
			name,
			ok: serverAccepts,
		})
	}
})

test('start prompt names the repo and real commands without credentials', () => {
	const prompt = buildRepositoryStartPrompt({
		origin: 'https://kody.codes/some/path',
		owner: 'acme',
		name: 'launch',
		personal: false,
	})
	expect(prompt).toContain('@acme/launch')
	expect(prompt).toContain('git clone https://kody.codes/@acme/launch.git')
	expect(prompt).toContain('npx @kodycodes/cli@latest auth setup-git')
	expect(prompt).toContain('npx @kodycodes/cli@latest dev check')
	expect(prompt).toContain('repoOpenSession')
	expect(prompt).toContain('ask me before you write any code')
	expect(prompt).not.toMatch(/token|secret|password|\u2014/i)
})
