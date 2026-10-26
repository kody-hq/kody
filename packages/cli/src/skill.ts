import { spawn, type SpawnOptions } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { defaultMcpUrl } from './defaults.js'

const skillRelativePath = 'skills/kody/SKILL.md'
const hostedSkillName = 'kody-cli'
const skillFrontmatter = `---
name: kody
description: >
  Install and bootstrap the Kody CLI, then prefer \`execute --local\` when Node
  and a shell are available. Use when the person mentions Kody or wants local
  execute instead of hosted Worker compute days.
---

`

export const hostedAgentSkillsIndexPath = '/.well-known/agent-skills/index.json'

export type SkillTarget = {
	host: string
	path: string
}

export function bundledSkillPath(): string {
	return join(fileURLToPath(new URL('../', import.meta.url)), skillRelativePath)
}

export function agentSkillsOriginFromMcpUrl(
	mcpUrl: string = defaultMcpUrl,
): string {
	return new URL(mcpUrl).origin
}

export function userSkillTargets(home: string = homedir()): Array<SkillTarget> {
	return [
		{
			host: 'Claude Code',
			path: join(home, '.claude', 'skills', 'kody', 'SKILL.md'),
		},
		{
			host: 'Cursor',
			path: join(home, '.cursor', 'skills', 'kody', 'SKILL.md'),
		},
		{
			host: 'Codex',
			path: join(home, '.codex', 'skills', 'kody', 'SKILL.md'),
		},
		{
			host: 'Agents',
			path: join(home, '.agents', 'skills', 'kody', 'SKILL.md'),
		},
	]
}

export function projectSkillTargets(
	cwd: string = process.cwd(),
): Array<SkillTarget> {
	return [
		{
			host: 'Agents',
			path: join(cwd, '.agents', 'skills', 'kody', 'SKILL.md'),
		},
		{
			host: 'Cursor',
			path: join(cwd, '.cursor', 'skills', 'kody', 'SKILL.md'),
		},
		{
			host: 'Codex',
			path: join(cwd, '.codex', 'skills', 'kody', 'SKILL.md'),
		},
		{
			host: 'Claude Code',
			path: join(cwd, '.claude', 'skills', 'kody', 'SKILL.md'),
		},
	]
}

export function sha256Digest(body: string): string {
	return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`
}

export function wrapHostedSkillBody(body: string): string {
	const trimmed = body.replace(/^\uFEFF/, '')
	if (trimmed.startsWith('---\n') || trimmed.startsWith('---\r\n')) {
		return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`
	}
	const normalized = trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`
	return `${skillFrontmatter}${normalized}`
}

/** Body bytes that should match the hosted index digest (no local frontmatter). */
export function extractSkillBodyForDigest(fileContents: string): string {
	const trimmed = fileContents.replace(/^\uFEFF/, '')
	if (!trimmed.startsWith('---')) {
		return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`
	}
	const end = trimmed.indexOf('\n---', 3)
	if (end === -1) {
		return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`
	}
	const body = trimmed.slice(end + '\n---'.length).replace(/^(?:\r?\n)+/, '')
	return body.endsWith('\n') ? body : `${body}\n`
}

type HostedSkillIndexEntry = {
	name: string
	url: string
	digest: string
}

/** Bound hosted skill fetches so install/refresh can fall back offline. */
export const hostedSkillFetchTimeoutMs = 5_000

export async function fetchHostedKodyCliSkill(input: {
	origin?: string
	fetchImpl?: typeof fetch
	timeoutMs?: number
}): Promise<{ body: string; digest: string; url: string } | null> {
	const origin = (input.origin ?? agentSkillsOriginFromMcpUrl()).replace(
		/\/$/,
		'',
	)
	const fetchImpl = input.fetchImpl ?? fetch
	const timeoutMs = input.timeoutMs ?? hostedSkillFetchTimeoutMs
	try {
		const indexResponse = await fetchImpl(
			`${origin}${hostedAgentSkillsIndexPath}`,
			{
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(timeoutMs),
			},
		)
		if (!indexResponse.ok) return null
		const index = (await indexResponse.json()) as {
			skills?: Array<HostedSkillIndexEntry>
		}
		const entry = index.skills?.find((skill) => skill.name === hostedSkillName)
		if (!entry?.url || !entry.digest) return null
		const skillResponse = await fetchImpl(entry.url, {
			headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.8' },
			signal: AbortSignal.timeout(timeoutMs),
		})
		if (!skillResponse.ok) return null
		const rawBody = await skillResponse.text()
		const body = rawBody.endsWith('\n') ? rawBody : `${rawBody}\n`
		// Index and markdown can drift across independent caches; only accept
		// a body that matches the advertised digest.
		if (sha256Digest(body) !== entry.digest) return null
		return {
			body,
			digest: entry.digest,
			url: entry.url,
		}
	} catch {
		return null
	}
}

export async function installSkill(input: {
	project?: boolean
	cwd?: string
	home?: string
	sourcePath?: string
	origin?: string
	fetchImpl?: typeof fetch
}): Promise<Array<SkillTarget>> {
	const hosted = input.sourcePath
		? null
		: await fetchHostedKodyCliSkill({
				origin: input.origin,
				fetchImpl: input.fetchImpl,
			})
	const source = input.sourcePath ?? bundledSkillPath()
	const body = hosted
		? wrapHostedSkillBody(hosted.body)
		: await readFile(source, 'utf8')
	const targets = input.project
		? projectSkillTargets(input.cwd)
		: userSkillTargets(input.home)
	for (const target of targets) {
		await mkdir(dirname(target.path), { recursive: true })
		await writeFile(target.path, body, 'utf8')
	}
	return targets
}

/**
 * Refresh user-level installed skill copies when the hosted digest changed.
 * Best-effort: missing files and network failures are ignored. Project copies
 * are left alone so a repo that ships or commits its own skill is not rewritten
 * by an unrelated CLI command.
 */
export async function refreshInstalledSkills(
	input: {
		home?: string
		origin?: string
		fetchImpl?: typeof fetch
	} = {},
): Promise<Array<SkillTarget>> {
	const hosted = await fetchHostedKodyCliSkill({
		origin: input.origin,
		fetchImpl: input.fetchImpl,
	})
	if (!hosted) return []
	const nextBody = wrapHostedSkillBody(hosted.body)
	const refreshed: Array<SkillTarget> = []
	const candidates = userSkillTargets(input.home)
	for (const target of candidates) {
		try {
			const current = await readFile(target.path, 'utf8')
			const currentDigest = sha256Digest(extractSkillBodyForDigest(current))
			if (currentDigest === hosted.digest) continue
			await writeFileAtomic(target.path, nextBody)
			refreshed.push(target)
		} catch {
			// One locked or missing host copy must not abort the others.
			continue
		}
	}
	return refreshed
}

/** Write then rename so concurrent readers never see a partial skill file. */
export async function writeFileAtomic(
	path: string,
	body: string,
): Promise<void> {
	const dir = dirname(path)
	const temp = join(
		dir,
		`.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`,
	)
	try {
		await writeFile(temp, body, 'utf8')
		await rename(temp, path)
	} catch (error) {
		try {
			await unlink(temp)
		} catch {
			// Best-effort temp cleanup after a failed write or rename.
		}
		throw error
	}
}

export function skillRefreshEntryPath(): string {
	return fileURLToPath(new URL('./skill-refresh.js', import.meta.url))
}

/**
 * Spawn a detached child to refresh hosted skills so the parent CLI can exit
 * without waiting on network I/O. Best-effort; spawn failures are ignored.
 */
type SkillRefreshChild = {
	unref: () => void
	on?: (event: string, listener: (...args: Array<unknown>) => void) => unknown
}

export function scheduleDetachedSkillRefresh(
	input: {
		origin?: string
		spawnImpl?: (
			command: string,
			args: Array<string>,
			options: SpawnOptions,
		) => SkillRefreshChild
	} = {},
): void {
	const spawnFn = input.spawnImpl ?? spawn
	const args = [skillRefreshEntryPath()]
	if (input.origin) {
		args.push('--origin', input.origin)
	}
	try {
		const child = spawnFn(process.execPath, args, {
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
			env: {
				...process.env,
				KODY_SKIP_SKILL_REFRESH: '1',
			},
		})
		// Async spawn failures emit `error`; without a listener Node can abort
		// the parent. Ignore them so the user's command still completes.
		child.on?.('error', () => {})
		child.unref()
	} catch {
		// Ignore sync spawn failures; the user's command still runs.
	}
}
