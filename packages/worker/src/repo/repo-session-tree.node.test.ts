import { expect, test } from 'vitest'
import { isRepoDisallowedPathMessage } from './repo-session-caller-error.ts'
import {
	canonicalRepoPath,
	resolveRepoWorkspacePath,
} from './repo-session-tree.ts'

const workspacePrefix = '/session'

test('resolveRepoWorkspacePath keeps in-workspace .. and rejects escapes and .git', () => {
	expect(
		resolveRepoWorkspacePath('src/../exports/self-test.ts', workspacePrefix),
	).toBe('/session/exports/self-test.ts')
	expect(
		resolveRepoWorkspacePath(
			'/session/src/../exports/self-test.ts',
			workspacePrefix,
		),
	).toBe('/session/exports/self-test.ts')
	expect(
		resolveRepoWorkspacePath('exports/self-test.ts', workspacePrefix),
	).toBe('/session/exports/self-test.ts')
	expect(resolveRepoWorkspacePath('src/./lib/index.ts', workspacePrefix)).toBe(
		'/session/src/lib/index.ts',
	)
	expect(resolveRepoWorkspacePath('.', workspacePrefix)).toBe(workspacePrefix)
	expect(resolveRepoWorkspacePath(workspacePrefix, workspacePrefix)).toBe(
		workspacePrefix,
	)

	expect(() => resolveRepoWorkspacePath('../secrets', workspacePrefix)).toThrow(
		'Repo path "../secrets" is not allowed for repo session paths: resolved path leaves the session workspace.',
	)
	expect(() =>
		resolveRepoWorkspacePath('/session/../etc/passwd', workspacePrefix),
	).toThrow(
		'Repo path "/session/../etc/passwd" is not allowed for repo session paths: resolved path leaves the session workspace.',
	)
	expect(() =>
		resolveRepoWorkspacePath('src/.git/config', workspacePrefix),
	).toThrow(
		'Repo path "src/.git/config" is not allowed for repo session paths: paths cannot contain ".git" segments.',
	)
	expect(() =>
		resolveRepoWorkspacePath('src/foo/../.git/config', workspacePrefix),
	).toThrow(
		'Repo path "src/foo/../.git/config" is not allowed for repo session paths: paths cannot contain ".git" segments.',
	)
	expect(() => resolveRepoWorkspacePath('   ', workspacePrefix)).toThrow(
		'A non-empty repo path is required.',
	)

	expect(
		isRepoDisallowedPathMessage(
			'Repo path "src/../exports/self-test.ts" is not allowed: paths cannot contain ".." or ".git" segments.',
		),
	).toBe(true)
	expect(
		isRepoDisallowedPathMessage(
			'Repo path "src/.git/config" is not allowed for repo session paths: paths cannot contain ".git" segments.',
		),
	).toBe(true)
	expect(isRepoDisallowedPathMessage('Source "abc" was not found.')).toBe(false)
})

test('canonicalRepoPath spells equivalent repo paths the same way', () => {
	expect(canonicalRepoPath('./skills/example/SKILL.md')).toBe(
		'skills/example/SKILL.md',
	)
	expect(canonicalRepoPath('skills//example/SKILL.md')).toBe(
		'skills/example/SKILL.md',
	)
	expect(canonicalRepoPath('skills/../skills/example/SKILL.md')).toBe(
		'skills/example/SKILL.md',
	)
})
