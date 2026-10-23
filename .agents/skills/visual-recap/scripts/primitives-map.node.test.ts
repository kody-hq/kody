import { expect, test } from 'vitest'
import {
	classifyPaths,
	parsePrimitivesMap,
	pathMatchesRoot,
} from './primitives-map.mjs'

test('parsePrimitivesMap reads taxonomy fields and oxfmt-folded summaries', () => {
	const map = parsePrimitivesMap(`
version: 1
groups:
  - id: auth
    name: Identity & auth
primitives:
  - id: app-sessions
    group: auth
    name: Browser sessions
    summary: Cookie sessions and signup.
    code:
      - packages/worker/src/app/handlers/auth.ts
    docs:
      - docs/contributing/architecture/authentication.md
  - id: folded
    group: auth
    name: Folded
    summary:
      Folded onto the next indented line.
invariants:
  - id: per-user-isolation
    summary: userId scopes every path.
`)
	expect(map.version).toBe(1)
	expect(map.groups).toEqual([{ id: 'auth', name: 'Identity & auth' }])
	expect(map.primitives).toHaveLength(2)
	expect(map.primitives[0]).toMatchObject({
		id: 'app-sessions',
		group: 'auth',
		name: 'Browser sessions',
		summary: 'Cookie sessions and signup.',
		code: ['packages/worker/src/app/handlers/auth.ts'],
		docs: ['docs/contributing/architecture/authentication.md'],
	})
	expect(map.primitives[1]?.summary).toBe('Folded onto the next indented line.')
	expect(map.invariants[0]?.id).toBe('per-user-isolation')
})

test('classifyPaths longest-prefix match respects directory and prefix roots', () => {
	const roots = [
		[
			'packages/worker/src/app/handlers/auth.ts',
			'packages/worker/src/app/',
			true,
		],
		['packages/worker/src/apple.ts', 'packages/worker/src/app/', false],
		[
			'packages/worker/src/app/oauth-providers.ts',
			'packages/worker/src/app/oauth-',
			true,
		],
		['packages/worker/src/mcp-auth.ts', 'packages/worker/src/mcp/', false],
	] as const
	expect(roots.map(([path, root]) => pathMatchesRoot(path, root))).toEqual(
		roots.map(([, , matches]) => matches),
	)

	const map = parsePrimitivesMap(`
version: 1
groups:
  - id: surfaces
    name: Entry points
  - id: assistant
    name: Assistant
primitives:
  - id: mcp-server
    group: surfaces
    name: MCP endpoint
    summary: MCP server.
    code:
      - packages/worker/src/mcp/
  - id: saved-packages
    group: assistant
    name: Saved packages
    summary: Packages.
    code:
      - packages/worker/src/mcp/capabilities/packages/
`)
	const { matched, unmatched } = classifyPaths(
		[
			'packages/worker/src/mcp/capabilities/packages/save.ts',
			'packages/worker/src/mcp/index.ts',
			'README.md',
		],
		map,
	)
	expect(unmatched).toEqual(['README.md'])
	expect(matched.map((entry) => entry.primitive.id).sort()).toEqual([
		'mcp-server',
		'saved-packages',
	])
	expect(
		matched.find((entry) => entry.primitive.id === 'saved-packages')?.files,
	).toEqual(['packages/worker/src/mcp/capabilities/packages/save.ts'])
})
