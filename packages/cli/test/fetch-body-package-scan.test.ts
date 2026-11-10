import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	findPackageFetchBodyWarnings,
	moduleLoaderForPath,
} from '../src/fetch-body-package-scan.js'

const unresolvedBodyFetch =
	"export async function send(body: string) {\n\treturn fetch('https://api.example.com', { method: 'POST', body })\n}\n"

async function withTree(
	files: Record<string, string>,
	fn: (root: string) => Promise<void>,
) {
	const root = await mkdtemp(join(tmpdir(), 'kody-fetch-body-scan-'))
	try {
		for (const [path, content] of Object.entries(files)) {
			await mkdir(join(root, path, '..'), { recursive: true })
			await writeFile(join(root, path), content)
		}
		await fn(root)
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 10 })
	}
}

test('moduleLoaderForPath picks the loader by extension', () => {
	assert.equal(moduleLoaderForPath('src/app.ts'), 'ts')
	assert.equal(moduleLoaderForPath('src/app.mts'), 'ts')
	assert.equal(moduleLoaderForPath('src/app.cts'), 'ts')
	assert.equal(moduleLoaderForPath('src/app.tsx'), 'tsx')
	assert.equal(moduleLoaderForPath('src/app.jsx'), 'jsx')
	assert.equal(moduleLoaderForPath('src/app.js'), 'js')
	assert.equal(moduleLoaderForPath('src/app.mjs'), 'js')
})

for (const [label, generic] of [
	['generic arrow', 'const first = <T>(xs: T[]): T | undefined => xs[0]'],
	['generic arrow with trailing comma', 'const first = <T,>(xs: T[]) => xs[0]'],
	['function declaration', 'function first<T>(xs: T[]) { return xs[0] }'],
] as const) {
	test(`follows imports from a .ts entry with a ${label}`, async () => {
		await withTree(
			{
				'src/app.ts': `import { send } from './send.ts'\n${generic}\nexport default { async fetch() { await send(String(first([1]))); return new Response('ok') } }\n`,
				'src/send.ts': unresolvedBodyFetch,
			},
			async (root) => {
				const hits = await findPackageFetchBodyWarnings({
					entryPath: join(root, 'src/app.ts'),
					packageRoot: root,
				})
				assert.deepEqual(hits, [{ path: 'src/send.ts', line: 2 }])
			},
		)
	})
}

test('follows imports from a .tsx entry with JSX', async () => {
	await withTree(
		{
			'src/app.tsx': `import { send } from './send.ts'\nconst view = <main>hi</main>\nexport default { async fetch() { await send(String(view)); return new Response('ok') } }\n`,
			'src/send.ts': unresolvedBodyFetch,
		},
		async (root) => {
			const hits = await findPackageFetchBodyWarnings({
				entryPath: join(root, 'src/app.tsx'),
				packageRoot: root,
			})
			assert.deepEqual(hits, [{ path: 'src/send.ts', line: 2 }])
		},
	)
})
