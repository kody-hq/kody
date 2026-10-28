import { expect, test, vi } from 'vitest'
import {
	repoSearchEmptyPatternMessagePrefix,
	repoSearchInvalidRegexMessagePrefix,
} from './repo-session-caller-error.ts'
import { expandBraceGlobs, searchRepoWorkspace } from './repo-session-search.ts'

test('brace globs expand for Workspace.glob and reject pathological nesting', async () => {
	expect(expandBraceGlobs('/{README.md,package.json,**/README*}')).toEqual([
		'/README.md',
		'/package.json',
		'/**/README*',
	])
	expect(expandBraceGlobs('**/*.{ts,tsx}')).toEqual(['**/*.ts', '**/*.tsx'])
	expect(expandBraceGlobs('src/{a,{b,c}}/x')).toEqual([
		'src/a/x',
		'src/b/x',
		'src/c/x',
	])
	expect(expandBraceGlobs('plain.txt')).toEqual(['plain.txt'])
	expect(expandBraceGlobs('{unclosed')).toEqual(['{unclosed'])

	let nested = 'x'
	for (let index = 0; index < 20; index += 1) {
		nested = `{${nested}}`
	}
	expect(() => expandBraceGlobs(nested)).toThrow(/brace nesting exceeds 16/)

	const globCalls: Array<string> = []
	const files = new Map<string, string>([
		['/README.md', 'hello from readme'],
		['/package.json', '{"name":"demo"}'],
		['/docs/README.extra.md', 'hello from nested readme'],
		['/src/index.ts', 'hello from source'],
	])

	const result = await searchRepoWorkspace({
		root: '/',
		pattern: 'hello',
		glob: '/{README.md,package.json,**/README*}',
		workspace: {
			async glob(pattern) {
				globCalls.push(pattern)
				// Mimic @cloudflare/shell Workspace.glob: brace groups that still
				// contain wildcards throw SyntaxError ("Nothing to repeat").
				if (/\{[^}]*[*?]/.test(pattern)) {
					throw new SyntaxError(
						`Invalid regular expression: /^${pattern}$/: Nothing to repeat`,
					)
				}
				return [...files.keys()]
					.filter((path) => {
						if (pattern === '/README.md') return path === '/README.md'
						if (pattern === '/package.json') return path === '/package.json'
						if (pattern === '/**/README*') {
							return path === '/README.md' || path.endsWith('/README.extra.md')
						}
						return false
					})
					.map((path) => ({ path, type: 'file' }))
			},
			async readFile(path) {
				return files.get(path) ?? null
			},
		},
		toExternalPath(path) {
			return path.replace(/^\//, '')
		},
	})

	expect(globCalls).toEqual(['/README.md', '/package.json', '/**/README*'])
	expect(result.totalFiles).toBe(2)
	expect(result.totalMatches).toBe(2)
	expect(result.files.map((file) => file.path).sort()).toEqual([
		'README.md',
		'docs/README.extra.md',
	])

	const workspace = {
		glob: vi.fn(async () => []),
		readFile: vi.fn(async () => null),
	}
	await expect(
		searchRepoWorkspace({
			root: '/',
			pattern: 'x',
			glob: '{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}',
			workspace,
			toExternalPath: (path) => path,
		}),
	).rejects.toThrow(/expands to more than 64 patterns/)
	expect(workspace.glob).not.toHaveBeenCalled()
})

test('regex mode rejects Python-style inline flags with JS guidance', async () => {
	const workspace = {
		glob: vi.fn(async () => [{ path: '/src/a.ts', type: 'file' }]),
		readFile: vi.fn(async () => 'hello world'),
	}

	await expect(
		searchRepoWorkspace({
			root: '/',
			pattern: '(?s).|^$',
			mode: 'regex',
			workspace,
			toExternalPath: (path) => path,
		}),
	).rejects.toThrow(
		new RegExp(
			`${repoSearchInvalidRegexMessagePrefix}.*JavaScript RegExp`,
			's',
		),
	)
	// Invalid patterns fail before scanning files.
	expect(workspace.glob).not.toHaveBeenCalled()
	expect(workspace.readFile).not.toHaveBeenCalled()
})

test('blank and whitespace-only patterns reject before scanning', async () => {
	const workspace = {
		glob: vi.fn(async () => [{ path: '/src/a.ts', type: 'file' }]),
		readFile: vi.fn(async () => 'hello world'),
	}

	for (const pattern of ['', ' ', '\t', '  \n']) {
		await expect(
			searchRepoWorkspace({
				root: '/',
				pattern,
				workspace,
				toExternalPath: (path) => path,
			}),
		).rejects.toThrow(
			new RegExp(
				`${repoSearchEmptyPatternMessagePrefix}.*whitespace-only`,
				's',
			),
		)
	}
	expect(workspace.glob).not.toHaveBeenCalled()
	expect(workspace.readFile).not.toHaveBeenCalled()
})
