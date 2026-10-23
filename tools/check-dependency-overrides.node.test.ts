import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	checkDependencyOverrides,
	findDuplicateJsonKeys,
	listOverrideTargets,
} from './check-dependency-overrides.ts'

test('duplicate JSON keys are reported by path, ignoring strings that only look like keys', () => {
	const source = `{
		"name": "x",
		"description": "a \\"name\\": value, {\\"name\\": 1}",
		"overrides": {
			"fast-uri": "3.1.8",
			"hono": "4",
			"fast-uri": ">=3.1.8 <4.0.0",
			"wrangler": { "undici": "7", "undici": "7.30" }
		},
		"workspaces": ["a", "a"],
		"list": [{ "k": 1 }, { "k": 2 }],
		"name": "y"
	}`

	expect(findDuplicateJsonKeys(source)).toEqual([
		'overrides.fast-uri',
		'overrides.wrangler.undici',
		'name',
	])
})

test('nested and dot overrides resolve to the overridden package and its parents', () => {
	expect(
		listOverrideTargets({
			hono: '>=4.13.7 <5.0.0',
			wrangler: { undici: '>=7.29.1 <8.0.0' },
			foo: { '.': '1.0.0', bar: { baz: '2.0.0' } },
		}),
	).toEqual([
		{ packageName: 'hono', parents: [] },
		{ packageName: 'undici', parents: ['wrangler'] },
		{ packageName: 'foo', parents: [] },
		{ packageName: 'baz', parents: ['foo', 'bar'] },
	])
})

test('overrides check reports undocumented, stale, and duplicated overrides', async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), 'dependency-overrides-'))
	try {
		await mkdir(path.join(cwd, 'docs', 'contributing'), { recursive: true })
		const writePackageJson = (source: string) =>
			writeFile(path.join(cwd, 'package.json'), source)
		const writeDoc = (source: string) =>
			writeFile(
				path.join(cwd, 'docs', 'contributing', 'dependency-overrides.md'),
				source,
			)

		await writePackageJson(`{
			"overrides": {
				"hono": ">=4.13.7 <5.0.0",
				"fast-uri": "3.1.8",
				"fast-uri": ">=3.1.8 <4.0.0",
				"wrangler": { "undici": ">=7.29.1 <8.0.0" },
				"miniflare": { "undici": ">=7.29.1 <8.0.0" }
			}
		}`)
		await writeDoc(
			[
				'# Dependency overrides',
				'',
				'### `hono` → `>=4.13.7 <5.0.0`',
				'',
				'### `undici` (under wrangler / `miniflare` / `@cloudflare/vite-plugin`) → `>=7.29.1 <8.0.0`',
				'',
				'### `postcss` → `>=8.5.10 <9.0.0`',
				'',
				'### Untitled',
				'',
				'````md',
				'```',
				'### `fast-uri` → `3.1.8`',
				'```',
				'### `semver` → `7`',
				'````',
			].join('\n'),
		)

		await expect(checkDependencyOverrides(cwd)).resolves.toEqual({
			ok: false,
			errors: [
				'package.json repeats key "overrides.fast-uri"; JSON keeps only the last value, so the earlier entry is dead.',
				'package.json override "fast-uri" has no "### `fast-uri`" heading in docs/contributing/dependency-overrides.md. Document why it exists and when it can be removed.',
				'package.json override "wrangler > undici" has no "### `undici`" heading that also names `wrangler` in docs/contributing/dependency-overrides.md. Document why it exists and when it can be removed.',
				'docs/contributing/dependency-overrides.md:5 names `@cloudflare/vite-plugin` for `undici`, but package.json has no "@cloudflare/vite-plugin > undici" override. Remove the stale parent.',
				'docs/contributing/dependency-overrides.md:7 documents `postcss`, but package.json has no override for it. Remove the stale section.',
				'docs/contributing/dependency-overrides.md:9 heading must start with the overridden package name in backticks.',
			],
		})

		await writePackageJson(`{
			"overrides": {
				"hono": ">=4.13.7 <5.0.0",
				"fast-uri": ">=3.1.8 <4.0.0",
				"wrangler": { "undici": ">=7.29.1 <8.0.0" },
				"miniflare": { "undici": ">=7.29.1 <8.0.0" }
			}
		}`)
		await writeDoc(
			[
				'# Dependency overrides',
				'',
				'### `hono` → `>=4.13.7 <5.0.0`',
				'',
				'### `fast-uri` → `>=3.1.8 <4.0.0`',
				'',
				'### `undici` (under `wrangler` / `miniflare`) → `>=7.29.1 <8.0.0`',
			].join('\n'),
		)

		await expect(checkDependencyOverrides(cwd)).resolves.toEqual({
			ok: true,
			errors: [],
		})
	} finally {
		await rm(cwd, { recursive: true, force: true })
	}
})
