import { spawn } from 'node:child_process'
import {
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	utimes,
	writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, test, onTestFinished } from 'vitest'
import {
	ensureGuideCatalogModules,
	isLockStale,
	guideCatalogLockPath,
} from './build-guide-catalog-modules.ts'
import {
	type Guide,
	type GuideMetadata,
} from '#worker/guides/parse-frontmatter.ts'
import { guides as webGuides } from '#worker/guides/catalog.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// These tests delete outputs and forge lock owners. Keep every path away
// from the modules read by concurrent Workers tests and local dev servers.
async function createOutputFixture() {
	const generatedDir = await mkdtemp(
		path.join(tmpdir(), 'kody-guide-catalog-test-'),
	)
	const lockPath = guideCatalogLockPath(generatedDir)
	onTestFinished(async () => {
		await rm(generatedDir, { recursive: true, force: true })
		await rm(lockPath, { force: true })
	})
	return {
		generatedDir,
		lockPath,
		stampPath: path.join(generatedDir, 'guide-catalog.stamp.json'),
		metadataOutputPath: path.join(generatedDir, 'guide-metadata.mjs'),
		catalogOutputPath: path.join(generatedDir, 'guide-catalog.mjs'),
	}
}

function runBuilderProcess(outputDir: string): Promise<{
	code: number | null
	stdout: string
	stderr: string
}> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				'--input-type=module',
				'--eval',
				`import { ensureGuideCatalogModules } from './tools/build-guide-catalog-modules.ts'; await ensureGuideCatalogModules({ outputDir: process.argv[1] });`,
				outputDir,
			],
			{
				cwd: repoRoot,
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		)
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString()
		})
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString()
		})
		child.on('error', reject)
		child.on('close', (code) => resolve({ code, stdout, stderr }))
	})
}

/**
 * Reads a generated `export const <name> = JSON.parse("...")` module
 * straight off disk (no `import()`/module cache involved) and returns the
 * decoded payload. A torn concurrent write — a reader's worst case without
 * the atomic rename in `ensureGuideCatalogModules()` — would fail either
 * `JSON.parse` call here with a syntax error, so this doubles as the
 * atomicity assertion.
 */
function parseGeneratedModulePayload(content: string): unknown {
	const match = /^export const \w+ = JSON\.parse\((".*")\)\n$/m.exec(content)
	if (!match?.[1]) {
		throw new Error('Generated module did not match the expected shape.')
	}
	return JSON.parse(JSON.parse(match[1]) as string)
}

test('ensureGuideCatalogModules generates metadata and a full catalog matching the web catalog', async () => {
	const { generatedDir, metadataOutputPath, catalogOutputPath } =
		await createOutputFixture()
	await ensureGuideCatalogModules({ outputDir: generatedDir })
	const guideMetadataList = parseGeneratedModulePayload(
		await readFile(metadataOutputPath, 'utf8'),
	) as Array<GuideMetadata>

	expect(guideMetadataList.length).toBe(webGuides.length)
	const metadataById = new Map(
		guideMetadataList.map((guide) => [guide.id, guide]),
	)

	const guides = parseGeneratedModulePayload(
		await readFile(catalogOutputPath, 'utf8'),
	) as Array<Guide>
	expect(guides.length).toBe(webGuides.length)
	const fullById = new Map(guides.map((guide) => [guide.id, guide]))

	for (const webGuide of webGuides) {
		const { body, ...expectedMetadata } = webGuide
		expect(metadataById.get(webGuide.id)).toEqual(expectedMetadata)
		expect(fullById.get(webGuide.id)).toEqual(webGuide)
	}

	// Order matters, not just membership: the web catalog preserves an
	// intentional authored order (see `#worker/guides/guide-order.ts`), and
	// `codingGuideGet`'s schema description follows `guideMetadataList`
	// order directly.
	expect(guideMetadataList.map((guide) => guide.id)).toEqual(
		webGuides.map((guide) => guide.id),
	)
	expect(guides.map((guide) => guide.id)).toEqual(
		webGuides.map((guide) => guide.id),
	)
})

test('ensureGuideCatalogModules skips complete warm output and repairs a missing generated module', async () => {
	const { generatedDir, stampPath, metadataOutputPath } =
		await createOutputFixture()
	await ensureGuideCatalogModules({ outputDir: generatedDir })
	const before = await stat(stampPath)
	const beforeContent = await readFile(stampPath, 'utf8')

	await ensureGuideCatalogModules({ outputDir: generatedDir })

	const after = await stat(stampPath)
	const afterContent = await readFile(stampPath, 'utf8')
	expect(afterContent).toBe(beforeContent)
	expect(after.mtimeMs).toBe(before.mtimeMs)

	await rm(metadataOutputPath)
	await ensureGuideCatalogModules({ outputDir: generatedDir })
	expect(await readFile(metadataOutputPath, 'utf8')).toMatch(
		/^export const guideMetadata = JSON\.parse\(/m,
	)
})

test('guide catalog lock keeps a live owner regardless of age and recovers abandoned owners', async () => {
	const { lockPath } = await createOutputFixture()
	const oldTime = new Date(Date.now() - 120_000)
	try {
		await writeFile(lockPath, String(process.pid))
		await utimes(lockPath, oldTime, oldTime)
		expect(await isLockStale(lockPath)).toBe(false)

		await writeFile(lockPath, '2147483647')
		expect(await isLockStale(lockPath)).toBe(true)
	} finally {
		await rm(lockPath, { force: true })
	}
})

// Simulates the real trigger for this hardening: a clean checkout where
// `wrangler dev`/`build`/`deploy` (via wrangler-env.ts) and both vitest
// projects (via tools/vitest-global-setup-node.ts /
// tools/vitest-global-setup-workers.ts) can all
// race to regenerate the same gitignored output on first run. Spawns real
// child processes rather than concurrent in-process calls so the lock is
// actually exercised across process boundaries, not just across async tasks
// sharing one Node event loop.
test(
	'ensureGuideCatalogModules is cross-process safe: concurrent regeneration from a clean state converges on uncorrupted, consistent output',
	{ timeout: 30_000 },
	async () => {
		const {
			generatedDir,
			lockPath,
			stampPath,
			metadataOutputPath,
			catalogOutputPath,
		} = await createOutputFixture()

		const concurrency = 6
		const results = await Promise.all(
			Array.from({ length: concurrency }, () =>
				runBuilderProcess(generatedDir),
			),
		)
		for (const result of results) {
			expect(
				result.code,
				`builder process failed (stdout: ${result.stdout}, stderr: ${result.stderr})`,
			).toBe(0)
		}

		// Every contender either created its own uniquely-named temp file and
		// renamed it away, or never got far enough to create one; none should
		// be left behind. Same for the lock, released in every code path.
		const leftoverEntries = await readdir(generatedDir)
		expect(leftoverEntries.filter((name) => name.includes('.tmp-'))).toEqual([])
		await expect(stat(lockPath)).rejects.toThrow('ENOENT')

		const stampContent = await readFile(stampPath, 'utf8')
		expect(JSON.parse(stampContent)).toEqual({ hash: expect.any(String) })

		const metadataPayload = parseGeneratedModulePayload(
			await readFile(metadataOutputPath, 'utf8'),
		) as Array<{ id: string }>
		const catalogPayload = parseGeneratedModulePayload(
			await readFile(catalogOutputPath, 'utf8'),
		) as Array<{ id: string }>
		expect(metadataPayload.map((guide) => guide.id)).toEqual(
			webGuides.map((guide) => guide.id),
		)
		expect(catalogPayload).toEqual(webGuides)

		// The stamp published last must already reflect the fully-written
		// state: a further call finds nothing to do.
		const before = await stat(stampPath)
		await ensureGuideCatalogModules({ outputDir: generatedDir })
		const after = await stat(stampPath)
		expect(after.mtimeMs).toBe(before.mtimeMs)
	},
)
