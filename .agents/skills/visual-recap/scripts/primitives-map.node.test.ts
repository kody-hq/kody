import { expect, test } from 'vitest'
import {
	checkPrimitivesMapPaths,
	classifyPaths,
	isSupersededRecord,
	loadPrimitivesMap,
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
    adrs:
      - docs/contributing/decisions/0030-discord-guilds-join-on-social-login.md
  - id: folded
    group: auth
    name: Folded
    summary:
      Folded onto the next indented line.
    adrs: []
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
		adrs: [
			'docs/contributing/decisions/0030-discord-guilds-join-on-social-login.md',
		],
	})
	expect(map.primitives[1]?.summary).toBe('Folded onto the next indented line.')
	expect(map.primitives[1]?.adrs).toEqual([])
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

test('the real primitives map links only existing, current decision records', () => {
	const map = loadPrimitivesMap()
	expect(checkPrimitivesMapPaths(map)).toEqual([])
	expect(
		map.primitives.every((primitive) => Array.isArray(primitive.adrs)),
	).toBe(true)
})

test('checkPrimitivesMapPaths rejects broken, superseded, misplaced, and missing adrs', () => {
	const map = parsePrimitivesMap(`
version: 1
primitives:
  - id: broken
    group: auth
    name: Broken
    summary: Broken link.
    adrs:
      - docs/contributing/decisions/9999-does-not-exist.md
  - id: superseded
    group: auth
    name: Superseded
    summary: Superseded link.
    adrs:
      - docs/contributing/decisions/0010-account-record-table.md
  - id: misplaced
    group: auth
    name: Misplaced
    summary: ADR in docs.
    docs:
      - docs/contributing/decisions/0028-list-detail-expand.md
    adrs:
      - docs/contributing/architecture/index.md
  - id: dotted
    group: auth
    name: Dotted
    summary: ADR in docs via a relative segment.
    docs:
      - docs/contributing/architecture/../decisions/0028-list-detail-expand.md
    adrs: []
  - id: undeclared
    group: auth
    name: Undeclared
    summary: No adrs key.
  - id: bare
    group: auth
    name: Bare
    summary: adrs key with no items.
    adrs:
`)
	expect(
		checkPrimitivesMapPaths(map).map(({ id, path, reason }) => ({
			id,
			path,
			reason,
		})),
	).toEqual([
		{
			id: 'broken',
			path: 'docs/contributing/decisions/9999-does-not-exist.md',
			reason: 'adrs path missing or not a file',
		},
		{
			id: 'superseded',
			path: 'docs/contributing/decisions/0010-account-record-table.md',
			reason: 'adrs path is superseded; link the record that supersedes it',
		},
		{
			id: 'misplaced',
			path: 'docs/contributing/decisions/0028-list-detail-expand.md',
			reason: 'decision records belong in adrs, not docs',
		},
		{
			id: 'misplaced',
			path: 'docs/contributing/architecture/index.md',
			reason: 'adrs entries must be docs/contributing/decisions/NNNN-slug.md',
		},
		{
			id: 'dotted',
			path: 'docs/contributing/architecture/../decisions/0028-list-detail-expand.md',
			reason: 'decision records belong in adrs, not docs',
		},
		{
			id: 'undeclared',
			path: 'adrs',
			reason: 'missing adrs list (use `adrs: []` when no record applies)',
		},
		{
			id: 'bare',
			path: 'adrs',
			reason: 'missing adrs list (use `adrs: []` when no record applies)',
		},
	])
})

test('isSupersededRecord reads inline and section status lines', () => {
	expect(isSupersededRecord('# 1\n\n- **Status:** accepted\n')).toBe(false)
	expect(
		isSupersededRecord('# 1\n\n- **Status:** superseded by [2](./2.md)\n'),
	).toBe(true)
	expect(
		isSupersededRecord(
			'# 1\n\n- **Status:** accepted; the gate is superseded by 3\n',
		),
	).toBe(false)
	expect(isSupersededRecord('# 1\n\n## Status\n\nSuperseded by 2.\n')).toBe(
		true,
	)
})
