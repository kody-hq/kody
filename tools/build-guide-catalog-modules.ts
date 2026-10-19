import { createHash, randomUUID } from 'node:crypto'
import {
	access,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sortGuidesByAuthoredOrder } from '#worker/guides/guide-order.ts'
import {
	parseGuideMarkdown,
	type Guide,
	type GuideMetadata,
} from '#worker/guides/parse-frontmatter.ts'
import {
	rewriteRelativeGuideLinks,
	type GuideSourceDir,
} from '#worker/guides/rewrite-relative-links.ts'
import { isExecutedDirectly } from './node-runtime.ts'

/**
 * Generates the guide metadata/full-catalog modules that
 * `#worker/guide-catalog-modules.ts` exposes to the `codingGuideGet`
 * capability, from the canonical markdown in `docs/guides/`.
 *
 * Why: `#worker/guides/catalog.ts` statically imports every guide's raw
 * markdown and parses its frontmatter at module scope so the web `/docs`
 * pages always have the full catalog ready. Merely *registering* the MCP
 * `codingGuideGet` capability must not pay that same cost on every
 * platform/runtime Worker isolate cold start — the capability module only
 * needs a handful of small fields (id, summary, provider, …) to build its
 * description/keywords/input schema, and needs full guide bodies only while
 * actually handling a request.
 *
 * This generator produces two gitignored modules under
 * `packages/worker/src/generated/`:
 *
 * - `guide-metadata.mjs` — every guide's frontmatter (no body). Small enough
 *   to statically import; costs no per-guide parsing at runtime.
 * - `guide-catalog.mjs` — the full parsed catalog (with bodies, links
 *   rewritten the same way `#worker/guides/catalog.ts` does). Matches the
 *   allowlisted `generated/guide-catalog.mjs` rule in `wrangler.jsonc`, so
 *   Wrangler uploads it as a separate external module, excluded from the
 *   main worker script, that only loads when the *dynamic* `import()` in
 *   `#worker/guide-catalog-modules.ts` actually runs — unlike an ordinary
 *   dynamic import of an in-repo module, which Wrangler still bundles into
 *   the main script, adding to the code V8 must parse and link on every
 *   cold start even though execution of that code stays deferred.
 *
 * Both modules reuse `parseGuideMarkdown`/`rewriteRelativeGuideLinks` (the
 * same functions `catalog.ts` uses) so parsing/link-rewriting behavior never
 * drifts between the web catalog and the generated modules.
 *
 * Deterministic for a given `docs/guides/` tree, so a stamp file makes
 * re-runs a no-op (this runs in front of every wrangler dev/build/deploy and
 * once per vitest run).
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const guidesSourceDir = path.join(repoRoot, 'docs/guides')
const generatedDir = path.join(repoRoot, 'packages/worker/src/generated')

// Outside `src/generated` on purpose: that tree is still inside wrangler's
// additional-modules watch root (bundler wasm is not; see
// tools/build-worker-bundler-modules.ts / Friction #1789), so a lock file
// churning there could retrigger reload. Keyed by a hash of `generatedDir`
// (not a fixed name) so unrelated checkouts/worktrees on the same machine
// never contend on the same lock.
export function guideCatalogLockPath(outputDir: string) {
	return path.join(
		tmpdir(),
		`kody-guide-catalog-modules-${createHash('sha256').update(path.resolve(outputDir)).digest('hex').slice(0, 16)}.lock`,
	)
}
const lockPath = guideCatalogLockPath(generatedDir)
const lockAcquireTimeoutMs = 30_000
const lockRetryIntervalMs = 20
// A lock older than this (or whose owning pid is gone) is assumed abandoned
// by a crashed process, not held — otherwise a single killed process would
// wedge every future run.
const staleLockAgeMs = 60_000

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function isLockStale(targetLockPath = lockPath): Promise<boolean> {
	let lockStat
	try {
		lockStat = await stat(targetLockPath)
	} catch {
		// Lock disappeared since our failed create attempt; not stale, just
		// gone — the next create attempt will simply succeed.
		return false
	}
	try {
		const ownerPid = Number.parseInt(await readFile(targetLockPath, 'utf8'), 10)
		if (Number.isInteger(ownerPid)) {
			// Signal 0 probes liveness without actually sending a signal. A
			// live owner keeps its lock regardless of age; a slow build must
			// never be mistaken for an abandoned one.
			process.kill(ownerPid, 0)
			return false
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === 'ESRCH') return true
		if (code !== undefined) return false
	}

	// Only malformed owner data falls back to age-based recovery.
	return Date.now() - lockStat.mtimeMs > staleLockAgeMs
}

/**
 * Cross-process mutual exclusion via exclusive file creation (`wx`), so
 * concurrent `wrangler dev`/`build`/`deploy` invocations and concurrent
 * vitest projects (see `tools/vitest-global-setup-node.ts` /
 * `tools/vitest-global-setup-workers.ts`,
 * used by both `node-unit` and `workers-unit`) never regenerate/write the
 * same output files at once. Returns a release function; callers must call
 * it from a `finally` block.
 */
async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
	const deadline = Date.now() + lockAcquireTimeoutMs
	const ownerToken = String(process.pid)
	for (;;) {
		try {
			await writeFile(lockPath, ownerToken, { flag: 'wx' })
			return async () => {
				// Only remove the lock if it still names us: if this run's lock
				// was ever declared stale (see `isLockStale`) and reclaimed by
				// another process while we were still finishing up, blindly
				// unlinking here would delete *their* lock instead of ours.
				try {
					if ((await readFile(lockPath, 'utf8')) === ownerToken) {
						await rm(lockPath, { force: true })
					}
				} catch {
					// Already gone — nothing to release.
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
			if (await isLockStale(lockPath)) {
				await rm(lockPath, { force: true }).catch(() => {})
				continue
			}
			if (Date.now() > deadline) {
				throw new Error(
					`Timed out after ${String(lockAcquireTimeoutMs)}ms waiting for the guide catalog build lock at ${lockPath}.`,
				)
			}
			await delay(lockRetryIntervalMs)
		}
	}
}

/**
 * Writes via a unique per-call temp file in the same directory, then
 * `rename()`s into place. `rename` is atomic on the same filesystem, so any
 * concurrent reader (an `import()`, wrangler's module watcher, …) only ever
 * observes the fully-written previous or new content — never a torn write —
 * even without the lock above.
 */
async function writeFileAtomic(filePath: string, content: string) {
	const tempPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.tmp-${String(process.pid)}-${randomUUID()}`,
	)
	try {
		await writeFile(tempPath, content)
		await rename(tempPath, filePath)
	} finally {
		await rm(tempPath, { force: true })
	}
}

const generatedFileHeader =
	'// AUTO-GENERATED by tools/build-guide-catalog-modules.ts from docs/guides/**/*.md. Do not edit.\n'

/** Guide source files are markdown, excluding docs (no frontmatter fence). */
function isGuideMarkdownFile(fileName: string) {
	return fileName.endsWith('.md') && fileName.toLowerCase() !== 'readme.md'
}

async function findGuideMarkdownFiles(): Promise<ReadonlyArray<string>> {
	const entries = await readdir(guidesSourceDir, {
		recursive: true,
		withFileTypes: true,
	})
	return entries
		.filter((entry) => entry.isFile() && isGuideMarkdownFile(entry.name))
		.map((entry) => path.join(entry.parentPath, entry.name))
		.toSorted((a, b) => a.localeCompare(b))
}

function slugFromFilePath(filePath: string): string {
	return path.basename(filePath, '.md')
}

async function readGuideSources(
	filePaths: ReadonlyArray<string>,
): Promise<ReadonlyArray<{ slug: string; raw: string }>> {
	return Promise.all(
		filePaths.map(async (filePath) => ({
			slug: slugFromFilePath(filePath),
			raw: await readFile(filePath, 'utf8'),
		})),
	)
}

/**
 * Parses every guide, rewrites relative links, and sorts into authored
 * order, mirroring `buildCatalog()` in `#worker/guides/catalog.ts` exactly
 * (both use `sortGuidesByAuthoredOrder` from the shared `guide-order.ts`),
 * so `codingGuideGet`'s schema description never drifts from the web
 * catalog's order.
 */
function buildFullCatalog(
	sources: ReadonlyArray<{ slug: string; raw: string }>,
): ReadonlyArray<Guide> {
	const parsed = sources.map(({ slug, raw }) => parseGuideMarkdown(slug, raw))

	const ids = new Set<string>()
	for (const guide of parsed) {
		if (ids.has(guide.id)) {
			throw new Error(`Duplicate guide id "${guide.id}".`)
		}
		ids.add(guide.id)
	}

	const knownSlugs = new Set(parsed.map((guide) => guide.slug))
	const rewritten = parsed.map((guide) => {
		const sourceDir: GuideSourceDir =
			guide.category === 'provider' ? 'docs/guides/providers' : 'docs/guides'
		return {
			...guide,
			body: rewriteRelativeGuideLinks({
				body: guide.body,
				sourceDir,
				knownSlugs,
			}),
		}
	})
	return sortGuidesByAuthoredOrder(rewritten)
}

function toMetadata(
	guides: ReadonlyArray<Guide>,
): ReadonlyArray<GuideMetadata> {
	return guides.map(({ body, ...metadata }) => metadata)
}

/**
 * Renders `export const <exportName> = JSON.parse(<json-string-literal>)`.
 * Round-tripping through a JS string literal (rather than splicing the JSON
 * text in as an object literal) sidesteps any edge cases in embedding
 * arbitrary guide markdown as JS source syntax.
 */
function renderGeneratedModule(exportName: string, data: unknown): string {
	const json = JSON.stringify(data)
	const jsonAsStringLiteral = JSON.stringify(json)
	return `${generatedFileHeader}export const ${exportName} = JSON.parse(${jsonAsStringLiteral})\n`
}

async function buildStampContent(filePaths: ReadonlyArray<string>) {
	const generatorSource = await readFile(fileURLToPath(import.meta.url), 'utf8')
	const parseFrontmatterSource = await readFile(
		path.join(repoRoot, 'packages/worker/src/guides/parse-frontmatter.ts'),
		'utf8',
	)
	const rewriteLinksSource = await readFile(
		path.join(repoRoot, 'packages/worker/src/guides/rewrite-relative-links.ts'),
		'utf8',
	)
	const guideOrderSource = await readFile(
		path.join(repoRoot, 'packages/worker/src/guides/guide-order.ts'),
		'utf8',
	)
	// The order itself comes from the docs nav, so a reordering there must
	// invalidate the stamp too.
	const docsNavSource = await readFile(
		path.join(repoRoot, 'packages/worker/universal/docs-nav.ts'),
		'utf8',
	)
	const guideFileContents = await Promise.all(
		filePaths.map(async (filePath) => ({
			filePath: path.relative(repoRoot, filePath),
			raw: await readFile(filePath, 'utf8'),
		})),
	)
	const hash = createHash('sha256')
		.update(generatorSource)
		.update(parseFrontmatterSource)
		.update(rewriteLinksSource)
		.update(guideOrderSource)
		.update(docsNavSource)
		.update(JSON.stringify(guideFileContents))
		.digest('hex')
	return JSON.stringify({ hash }, null, '\t')
}

async function readStamp(stampPath: string): Promise<string | null> {
	try {
		return await readFile(stampPath, 'utf8')
	} catch {
		return null
	}
}

async function generatedOutputsExist(
	metadataOutputPath: string,
	catalogOutputPath: string,
) {
	try {
		await Promise.all([access(metadataOutputPath), access(catalogOutputPath)])
		return true
	} catch {
		return false
	}
}

async function fsyncGeneratedDir(generatedDir: string) {
	const handle = await open(generatedDir, 'r')
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

/**
 * Idempotent and cross-process safe: skips regeneration when the stamp
 * already matches (checked once up front, then again after acquiring the
 * lock, in case a concurrent process just finished regenerating while this
 * call was waiting). Every output — including the stamp itself — is written
 * through `writeFileAtomic`, and the stamp is published last, so a
 * concurrent reader (this function's own fast path, `wrangler dev`'s module
 * watcher, a vitest worker's dynamic `import()`) never observes a stamp that
 * matches before the catalog/metadata files it describes are fully written.
 */
export async function ensureGuideCatalogModules(
	options: { outputDir?: string } = {},
) {
	const outputDir = path.resolve(options.outputDir ?? generatedDir)
	const stampPath = path.join(outputDir, 'guide-catalog.stamp.json')
	const metadataOutputPath = path.join(outputDir, 'guide-metadata.mjs')
	const catalogOutputPath = path.join(outputDir, 'guide-catalog.mjs')
	let filePaths = await findGuideMarkdownFiles()
	let stampContent = await buildStampContent(filePaths)
	if (
		(await readStamp(stampPath)) === stampContent &&
		(await generatedOutputsExist(metadataOutputPath, catalogOutputPath))
	) {
		return
	}

	const release = await acquireLock(guideCatalogLockPath(outputDir))
	try {
		// The guide tree may have changed while this process waited. Refresh
		// the snapshot under the lock so the cache check and generated output
		// describe the same source state.
		filePaths = await findGuideMarkdownFiles()
		stampContent = await buildStampContent(filePaths)
		if (
			(await readStamp(stampPath)) === stampContent &&
			(await generatedOutputsExist(metadataOutputPath, catalogOutputPath))
		) {
			return
		}

		const sources = await readGuideSources(filePaths)
		const fullCatalog = buildFullCatalog(sources)
		const metadata = toMetadata(fullCatalog)

		await mkdir(outputDir, { recursive: true })
		await writeFileAtomic(
			metadataOutputPath,
			renderGeneratedModule('guideMetadata', metadata),
		)
		await writeFileAtomic(
			catalogOutputPath,
			renderGeneratedModule('guides', fullCatalog),
		)
		await writeFileAtomic(stampPath, stampContent)
		// Flush before `wrangler dev` starts watching `src/` (guide catalog
		// stays under the additional-module watch root; bundler wasm does
		// not — see tools/build-worker-bundler-modules.ts / Friction #1789).
		await fsyncGeneratedDir(outputDir)
	} finally {
		await release()
	}
}

if (isExecutedDirectly(import.meta.url)) {
	await ensureGuideCatalogModules()
}
