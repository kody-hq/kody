import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Matches the worker's `publishOffloadLimits.uploadChunkBytes`. */
const publishBuildChunkBytes = 4 * 1024 * 1024

type PublishBuiltTarget = {
	target: {
		kind: string
		bundleKind: 'app' | 'app-client' | 'module' | 'importable-module'
		artifactName?: string | null
		entryPoint: string
	}
	mainModule: string
	/** Tagged module bytes, exactly what Kody hashes (`workerLoaderModuleBytes`). */
	modules: Record<string, Uint8Array>
}

type PublishBuildFileManifestEntry = {
	path: string
	size: number
	sha256: string
}

export type PublishBuilder = {
	publishBuilderVersion: number
	/**
	 * `files` are the commit's raw blobs at repo-root paths. The builder
	 * turns them into the snapshot the server keeps (binary encoding,
	 * `.kodyignore`) and returns the manifest the server checks.
	 */
	buildPublishTargets(input: {
		files: Array<{ path: string; base64: string }>
		sourceRoot: string
		manifestPath: string
		rootPackageId: string
		userId: string
		baseUrl: string
	}): Promise<{
		files: Array<PublishBuildFileManifestEntry>
		targets: Array<PublishBuiltTarget>
	}>
	close(): Promise<void>
}

/** Matches the worker's `publishBuilderVersion`. */
const cliPublishBuilderVersion = 2

function sha256Hex(bytes: Uint8Array) {
	return createHash('sha256').update(bytes).digest('hex')
}

function builderWorkerdConfig(input: { wasmModules: Array<string> }) {
	const wasm = input.wasmModules
		.map(
			(name) =>
				`    (name = ${JSON.stringify(name)}, wasm = embed ${JSON.stringify(name)}),`,
		)
		.join('\n')
	return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [ (name = "main", worker = .builder) ],
  sockets = [ (name = "http", address = "127.0.0.1:0", http = (), service = "main") ],
);

const builder :Workerd.Worker = (
  modules = [
    (name = "publish-builder.js", esModule = embed "publish-builder.js"),
${wasm}
  ],
  compatibilityDate = "2026-04-16",
  compatibilityFlags = ["nodejs_compat"],
);
`
}

/**
 * The worker's bundler only runs inside workerd, so serve the builder
 * (`dist/publish-builder.js`, built from the worker's own source) from a
 * local workerd with no network and no bindings, and POST the tree to it.
 */
async function loadPublishBuilder(): Promise<PublishBuilder> {
	const { fileURLToPath } = await import('node:url')
	const distDir =
		process.env.KODY_PUBLISH_BUILDER_DIR ??
		path.dirname(fileURLToPath(import.meta.url))
	const workDir = await mkdtemp(path.join(tmpdir(), 'kody-publish-builder-'))
	try {
		return await startPublishBuilder({ distDir, workDir })
	} catch (error) {
		await rm(workDir, { recursive: true, force: true })
		throw error
	}
}

async function startPublishBuilder(input: {
	distDir: string
	workDir: string
}): Promise<PublishBuilder> {
	const { copyFile, readdir, writeFile } = await import('node:fs/promises')
	const { ensureWorkerdBinary } = await import('./workerd-binary.js')
	const { startWorkerd } = await import('./dev/workerd-process.js')
	const { distDir, workDir } = input
	const wasmDir = path.join(distDir, 'publish-builder-wasm')
	const wasmModules = await readdir(wasmDir).catch(() => [] as Array<string>)
	await copyFile(
		path.join(distDir, 'publish-builder.js'),
		path.join(workDir, 'publish-builder.js'),
	)
	for (const name of wasmModules) {
		await copyFile(path.join(wasmDir, name), path.join(workDir, name))
	}
	const configPath = path.join(workDir, 'config.capnp')
	await writeFile(configPath, builderWorkerdConfig({ wasmModules }))
	const workerdPath = await ensureWorkerdBinary()
	let stderr = ''
	const workerd = await startWorkerd({
		workerdPath,
		configPath,
		cwd: workDir,
		env: { PATH: process.env.PATH ?? '' },
		onStdoutLine: () => {},
		onStderrLine: (line) => {
			stderr = `${stderr}${line}\n`.slice(-4000)
		},
	})
	const close = async () => {
		await workerd.kill()
		await rm(workDir, { recursive: true, force: true })
	}
	return {
		publishBuilderVersion: cliPublishBuilderVersion,
		close,
		async buildPublishTargets(input) {
			const response = await fetch(`http://127.0.0.1:${workerd.port}/`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input),
			}).catch((error: unknown) => {
				throw new Error(
					`The local publish builder stopped: ${error instanceof Error ? error.message : String(error)}\n${stderr.trim()}`,
				)
			})
			const body = (await response.json()) as
				| {
						ok: true
						files: Array<PublishBuildFileManifestEntry>
						targets: Array<
							Omit<PublishBuiltTarget, 'modules'> & {
								modules: Record<string, string>
							}
						>
				  }
				| { ok: false; message: string }
			if (!body.ok) throw new Error(body.message)
			const targets = body.targets.map((entry) => ({
				...entry,
				modules: Object.fromEntries(
					Object.entries(entry.modules).map(([modulePath, base64]) => [
						modulePath,
						new Uint8Array(Buffer.from(base64, 'base64')),
					]),
				),
			}))
			return { files: body.files, targets }
		},
	}
}

export type PublishBuildTicket = {
	buildId: string
	packageId: string
	commit: string
	/** Entity source root and manifest path; default `/` and `package.json`. */
	sourceRoot?: string
	manifestPath?: string
	userId: string
	/** `…/v1/publish-builds/{buildId}` */
	uploadUrl: string
	ticket: string
}

export type LocalPublishBuildResult = {
	buildId: string
	commit: string
	targets: number
	uploadedChunks: number
	reusedChunks: number
	buildMs: number
}

async function git(
	cwd: string,
	args: Array<string>,
	env?: Record<string, string>,
) {
	const { stdout } = await execFileAsync('git', args, {
		cwd,
		...(env ? { env: { ...process.env, ...env } } : {}),
		maxBuffer: 256 * 1024 * 1024,
		encoding: 'buffer',
	})
	return stdout as Buffer
}

/**
 * Refuses unless `dir` is a clean checkout whose HEAD is `commit`, so the
 * bytes built here are exactly the pushed tree the server re-checks.
 */
async function assertCleanWorkingTree(dir: string) {
	const status = (await git(dir, ['status', '--porcelain'])).toString('utf8')
	if (status.trim()) {
		throw new Error(
			'Local publish builds need a clean working tree. Commit or stash your changes and try again.',
		)
	}
}

async function gitText(dir: string, args: Array<string>) {
	return (await git(dir, args)).toString('utf8').trim()
}

/**
 * 8B: refuse uncommitted changes, then push HEAD to its upstream branch (the
 * package's Kody remote) unless that branch is already at HEAD. Never
 * commits. The caller still has Kody confirm the commit before building.
 */
export async function pushHeadForPublish(
	dir: string,
	log: (line: string) => void = () => {},
) {
	await assertCleanWorkingTree(dir)
	const head = await gitText(dir, ['rev-parse', 'HEAD'])
	const branch = await gitText(dir, [
		'symbolic-ref',
		'--quiet',
		'--short',
		'HEAD',
	]).catch(() => '')
	const remote = branch
		? await gitText(dir, ['config', `branch.${branch}.remote`]).catch(() => '')
		: ''
	const mergeRef = branch
		? await gitText(dir, ['config', `branch.${branch}.merge`]).catch(() => '')
		: ''
	if (!remote || !mergeRef) {
		throw new Error(
			"Local publish builds push HEAD to its upstream branch on the package's Kody remote, and this checkout has none. Check out the branch and set its upstream (git push -u <kody remote> HEAD), then try again.",
		)
	}
	const remoteHead = (
		await gitText(dir, ['ls-remote', remote, mergeRef])
	).split(/\s/)[0]
	if (remoteHead === head) return { head, pushed: false }
	log(`Pushing ${head.slice(0, 12)} to ${remote} ${mergeRef}…`)
	await git(dir, ['push', '--quiet', remote, `HEAD:${mergeRef}`])
	return { head, pushed: true }
}

async function assertCleanCheckoutAt(dir: string, commit: string) {
	await assertCleanWorkingTree(dir)
	const head = (await git(dir, ['rev-parse', 'HEAD'])).toString('utf8').trim()
	if (head !== commit) {
		throw new Error(
			`Local HEAD ${head.slice(0, 12)} is not the pushed commit ${commit.slice(0, 12)}. Push HEAD (git push) or check out ${commit.slice(0, 12)}, then try again.`,
		)
	}
}

/** Every file in `commit`'s tree with its raw bytes. */
async function readCommitTree(dir: string, commit: string) {
	const listing = (await git(dir, ['ls-tree', '-r', '-z', commit]))
		.toString('utf8')
		.split('\0')
		.filter(Boolean)
	const files: Array<{ path: string; bytes: Buffer }> = []
	for (const line of listing) {
		const tab = line.indexOf('\t')
		const [mode, type, object] = line.slice(0, tab).split(' ')
		if (type !== 'blob' || mode === '120000' || !object) continue
		files.push({
			path: line.slice(tab + 1),
			bytes: await git(dir, ['cat-file', 'blob', object]),
		})
	}
	return files
}

function splitChunks(bytes: Uint8Array) {
	const chunks: Array<Uint8Array> = []
	for (
		let offset = 0;
		offset < bytes.byteLength;
		offset += publishBuildChunkBytes
	) {
		chunks.push(bytes.subarray(offset, offset + publishBuildChunkBytes))
	}
	if (chunks.length === 0) chunks.push(new Uint8Array())
	return chunks
}

/** The upload API lives on the Open API host the CLI already talks to. */
export function publishBuildUploadUrl(apiUrl: string, path: string) {
	return new URL(path, apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`).toString()
}

async function ticketFetch(
	fetchFn: typeof fetch,
	ticket: PublishBuildTicket,
	suffix: string,
	init: RequestInit = {},
) {
	const response = await fetchFn(`${ticket.uploadUrl}${suffix}`, {
		...init,
		headers: {
			...(init.headers as Record<string, string> | undefined),
			authorization: `Bearer ${ticket.ticket}`,
		},
	})
	const body = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null
	if (!response.ok && response.status !== 409) {
		const message =
			(body?.error as { message?: string } | undefined)?.message ??
			(typeof body?.message === 'string' ? body.message : null) ??
			`HTTP ${response.status}`
		throw new Error(`Publish build upload failed: ${message}`)
	}
	return { status: response.status, body: body ?? {} }
}

/**
 * Publish offload: build `ticket.commit` here with the worker's bundler,
 * upload content-addressed 4 MiB chunks (skipping ones already uploaded, so
 * a rerun resumes), then seal the build. Kody verifies and writes the
 * registry when the publish runs with this build id.
 */
export async function runLocalPublishBuild(input: {
	dir: string
	ticket: PublishBuildTicket
	apiUrl: string
	fetchFn?: typeof fetch
	/** Skip the clean-tree check (context builds use a fresh clone). */
	freshClone?: boolean
	loadBuilder?: () => Promise<PublishBuilder>
	log?: (line: string) => void
}): Promise<LocalPublishBuildResult> {
	const fetchFn = input.fetchFn ?? fetch
	const log = input.log ?? (() => {})
	if (!input.freshClone) {
		await assertCleanCheckoutAt(input.dir, input.ticket.commit)
	}
	const started = Date.now()
	const tree = await readCommitTree(input.dir, input.ticket.commit)
	log(`Building ${tree.length} files at ${input.ticket.commit.slice(0, 12)}…`)
	const builder = await (input.loadBuilder ?? loadPublishBuilder)()
	const { files, targets: built } = await builder
		.buildPublishTargets({
			files: tree.map((file) => ({
				path: file.path,
				base64: file.bytes.toString('base64'),
			})),
			sourceRoot: input.ticket.sourceRoot ?? '/',
			manifestPath: input.ticket.manifestPath ?? 'package.json',
			rootPackageId: input.ticket.packageId,
			userId: input.ticket.userId,
			baseUrl: input.apiUrl,
		})
		.finally(() => builder.close())
	const buildMs = Date.now() - started
	const status = await ticketFetch(fetchFn, input.ticket, '')
	const uploaded = new Set(
		Array.isArray(status.body.uploaded_chunks)
			? (status.body.uploaded_chunks as Array<string>)
			: [],
	)
	let uploadedChunks = 0
	let reusedChunks = 0
	const targets = []
	for (const entry of built) {
		const modules: Record<
			string,
			{ sha256: string; size: number; chunks: Array<string> }
		> = {}
		for (const [modulePath, bytes] of Object.entries(entry.modules)) {
			const chunks = []
			for (const chunk of splitChunks(bytes)) {
				const sha = sha256Hex(chunk)
				chunks.push(sha)
				if (uploaded.has(sha)) {
					reusedChunks += 1
					continue
				}
				await ticketFetch(fetchFn, input.ticket, `/blobs/${sha}`, {
					method: 'PUT',
					headers: { 'content-type': 'application/octet-stream' },
					body: chunk,
				})
				uploaded.add(sha)
				uploadedChunks += 1
			}
			modules[modulePath] = {
				sha256: sha256Hex(bytes),
				size: bytes.byteLength,
				chunks,
			}
		}
		targets.push({
			kind: entry.target.kind,
			bundleKind: entry.target.bundleKind,
			artifactName: entry.target.artifactName ?? null,
			entryPoint: entry.target.entryPoint,
			mainModule: entry.mainModule,
			modules,
		})
	}
	const sealed = await ticketFetch(fetchFn, input.ticket, '/seal', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			builderVersion: builder.publishBuilderVersion,
			commit: input.ticket.commit,
			files,
			targets,
			buildMs,
		}),
	})
	if (sealed.status === 409) {
		throw new Error(
			'Kody is missing some uploaded chunks (they may have expired). Run the build again; it resumes from what is already uploaded.',
		)
	}
	return {
		buildId: input.ticket.buildId,
		commit: input.ticket.commit,
		targets: targets.length,
		uploadedChunks,
		reusedChunks,
		buildMs,
	}
}

/**
 * Git reads `GIT_CONFIG_*` from its environment, which other local users
 * cannot read (unlike argv), so the clone token never reaches a command
 * line or the fetched remote URL.
 */
export function contextCloneGitEnv(token: string) {
	const password = token.split('?expires=')[0] ?? ''
	return {
		GIT_TERMINAL_PROMPT: '0',
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'http.extraHeader',
		GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x:${password}`).toString('base64')}`,
	}
}

/**
 * Context builds: clone one commit with the read-only, single-repo token
 * from the run request (never the operator's CLI login), build, upload.
 */
export async function runContextPublishBuild(input: {
	source: {
		buildId: string
		packageId: string
		commit: string
		sourceRoot?: string
		manifestPath?: string
		clone: { remote: string; token: string }
		upload: { path: string; ticket: string }
	}
	userId: string
	apiUrl: string
	fetchFn?: typeof fetch
	loadBuilder?: () => Promise<PublishBuilder>
}) {
	const dir = await mkdtemp(path.join(tmpdir(), 'kody-publish-build-'))
	try {
		await git(dir, ['init', '--quiet'])
		await git(
			dir,
			[
				'-c',
				'credential.helper=',
				'fetch',
				'--quiet',
				'--depth=1',
				input.source.clone.remote,
				input.source.commit,
			],
			contextCloneGitEnv(input.source.clone.token),
		)
		return await runLocalPublishBuild({
			dir,
			freshClone: true,
			apiUrl: input.apiUrl,
			...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
			...(input.loadBuilder ? { loadBuilder: input.loadBuilder } : {}),
			ticket: {
				buildId: input.source.buildId,
				packageId: input.source.packageId,
				commit: input.source.commit,
				...(input.source.sourceRoot
					? { sourceRoot: input.source.sourceRoot }
					: {}),
				...(input.source.manifestPath
					? { manifestPath: input.source.manifestPath }
					: {}),
				userId: input.userId,
				uploadUrl: publishBuildUploadUrl(
					input.apiUrl,
					input.source.upload.path,
				),
				ticket: input.source.upload.ticket,
			},
		})
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

/**
 * `kody dev check --build local`: run the same publish builder over the
 * working tree (tracked + untracked, not ignored) without uploading, so a
 * build problem shows up before publish.
 */
export async function buildWorkingTreeLocally(input: {
	dir: string
	packageId: string
	apiUrl: string
	loadBuilder?: () => Promise<PublishBuilder>
}) {
	const { readFile } = await import('node:fs/promises')
	const paths = (
		await git(input.dir, [
			'ls-files',
			'-z',
			'--cached',
			'--others',
			'--exclude-standard',
		])
	)
		.toString('utf8')
		.split('\0')
		.filter(Boolean)
	const files: Array<{ path: string; base64: string }> = []
	for (const file of paths) {
		try {
			const bytes = await readFile(path.join(input.dir, file))
			files.push({ path: file, base64: bytes.toString('base64') })
		} catch {
			// Deleted but still in the index.
		}
	}
	const started = Date.now()
	const builder = await (input.loadBuilder ?? loadPublishBuilder)()
	const built = await builder
		.buildPublishTargets({
			files,
			sourceRoot: '/',
			manifestPath: 'package.json',
			rootPackageId: input.packageId,
			userId: '',
			baseUrl: input.apiUrl,
		})
		.finally(() => builder.close())
	return { targets: built.targets.length, buildMs: Date.now() - started }
}
