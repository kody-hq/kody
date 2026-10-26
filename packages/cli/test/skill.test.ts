import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
	extractSkillBodyForDigest,
	installSkill,
	projectSkillTargets,
	refreshInstalledSkills,
	scheduleDetachedSkillRefresh,
	sha256Digest,
	skillRefreshEntryPath,
	userSkillTargets,
	wrapHostedSkillBody,
} from '../src/skill.js'

const sourcePath = fileURLToPath(
	new URL('../skills/kody/SKILL.md', import.meta.url),
)

test('installSkill writes the bundled skill to user host directories', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-skill-home-'))
	const targets = await installSkill({
		home,
		sourcePath,
		fetchImpl: async () => {
			throw new Error('network should not be used when sourcePath is set')
		},
	})
	assert.equal(targets.length, userSkillTargets(home).length)
	assert.ok(targets.some((target) => target.host === 'Codex'))
	for (const target of targets) {
		assert.equal(
			readFileSync(target.path, 'utf8'),
			readFileSync(sourcePath, 'utf8'),
		)
	}
})

test('installSkill --project writes into the current workspace', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'kody-skill-project-'))
	const targets = await installSkill({
		project: true,
		cwd,
		sourcePath,
		fetchImpl: async () => {
			throw new Error('network should not be used when sourcePath is set')
		},
	})
	assert.deepEqual(
		targets.map((target) => target.path),
		projectSkillTargets(cwd).map((target) => target.path),
	)
})

test('installSkill prefers the hosted kody-cli skill when reachable', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-skill-hosted-'))
	const hostedBody = '# Kody CLI\n\nPrefer execute --local.\n'
	const digest = sha256Digest(hostedBody)
	const fetchImpl: typeof fetch = async (input) => {
		const url = String(input)
		if (url.endsWith('/.well-known/agent-skills/index.json')) {
			return new Response(
				JSON.stringify({
					skills: [
						{
							name: 'kody-cli',
							type: 'skill-md',
							description: 'CLI',
							url: 'https://kody.codes/.well-known/agent-skills/kody-cli/SKILL.md',
							digest,
						},
					],
				}),
				{ status: 200 },
			)
		}
		if (url.endsWith('/kody-cli/SKILL.md')) {
			return new Response(hostedBody, { status: 200 })
		}
		return new Response('missing', { status: 404 })
	}
	const targets = await installSkill({
		home,
		origin: 'https://kody.codes',
		fetchImpl,
	})
	const written = readFileSync(targets[0]!.path, 'utf8')
	assert.equal(written, wrapHostedSkillBody(hostedBody))
	assert.equal(sha256Digest(extractSkillBodyForDigest(written)), digest)
})

test('refreshInstalledSkills updates stale copies by digest', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-skill-refresh-'))
	const stalePath = userSkillTargets(home)[0]!.path
	mkdirSync(dirname(stalePath), { recursive: true })
	writeFileSync(stalePath, '# stale\n', 'utf8')

	const hostedBody = '# Kody CLI\n\nFresh hosted body.\n'
	const digest = sha256Digest(hostedBody)
	const fetchImpl: typeof fetch = async (input) => {
		const url = String(input)
		if (url.endsWith('/index.json')) {
			return new Response(
				JSON.stringify({
					skills: [
						{
							name: 'kody-cli',
							url: 'https://example.test/.well-known/agent-skills/kody-cli/SKILL.md',
							digest,
						},
					],
				}),
				{ status: 200 },
			)
		}
		return new Response(hostedBody, { status: 200 })
	}

	const refreshed = await refreshInstalledSkills({
		home,
		cwd: mkdtempSync(join(tmpdir(), 'kody-skill-refresh-cwd-')),
		origin: 'https://example.test',
		fetchImpl,
	})
	assert.equal(refreshed.length, 1)
	assert.equal(refreshed[0]!.path, stalePath)
	assert.equal(readFileSync(stalePath, 'utf8'), wrapHostedSkillBody(hostedBody))

	const second = await refreshInstalledSkills({
		home,
		cwd: mkdtempSync(join(tmpdir(), 'kody-skill-refresh-cwd2-')),
		origin: 'https://example.test',
		fetchImpl,
	})
	assert.equal(second.length, 0)
})

test('bundled skill stub points at the hosted kody-cli skill', () => {
	const stub = readFileSync(sourcePath, 'utf8')
	assert.match(stub, /\.well-known\/agent-skills\/kody-cli\/SKILL\.md/)
	assert.match(stub, /execute --local/)
	assert.match(stub, /cliCredentialBootstrap/)
})

test('scheduleDetachedSkillRefresh spawns an unrefed child and returns', () => {
	const calls: Array<{
		command: string
		args: Array<string>
		options: { detached?: boolean; stdio?: string }
	}> = []
	let unrefCalls = 0
	scheduleDetachedSkillRefresh({
		origin: 'https://kody.codes',
		spawnImpl: (command, args, options) => {
			calls.push({
				command,
				args: [...args],
				options: {
					detached: options.detached === true,
					stdio: typeof options.stdio === 'string' ? options.stdio : undefined,
				},
			})
			return {
				unref() {
					unrefCalls += 1
				},
			}
		},
	})
	assert.equal(calls.length, 1)
	assert.equal(calls[0]!.command, process.execPath)
	assert.deepEqual(calls[0]!.args, [
		skillRefreshEntryPath(),
		'--origin',
		'https://kody.codes',
	])
	assert.equal(calls[0]!.options.detached, true)
	assert.equal(calls[0]!.options.stdio, 'ignore')
	assert.equal(unrefCalls, 1)
})
