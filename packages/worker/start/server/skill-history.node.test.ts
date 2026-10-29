import { beforeEach, expect, test, vi } from 'vitest'
import { digestSnapshotContent } from '#worker/package-registry/package-skills.ts'
const state = vi.hoisted(() => ({
	scope: vi.fn(),
	catalog: vi.fn(),
	indexes: vi.fn(),
	snapshot: vi.fn(),
	manifest: vi.fn(),
	permissions: vi.fn(),
	authorize: vi.fn(),
	open: vi.fn(),
	restore: vi.fn(),
	commit: vi.fn(),
	checks: vi.fn(),
	publish: vi.fn(),
	discard: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let parse: (data: unknown) => unknown
		const builder = {
			validator(schema: { parse: (data: unknown) => unknown }) {
				parse = schema.parse
				return builder
			},
			handler(fn: (input: { data: unknown }) => unknown) {
				return (input: { data: unknown }) => fn({ data: parse(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('./collection-context.ts', () => ({
	loadScopedCollection: state.scope,
}))
vi.mock('./mutation-context.ts', () => ({
	withWebsiteMutation: (_scope: unknown, fn: () => unknown) => fn(),
}))
vi.mock('#mcp/skills/skills-catalog.ts', async (original) => ({
	...(await original<Record<string, unknown>>()),
	loadCallerSkillsCatalog: state.catalog,
}))
vi.mock('#worker/package-registry/skills-index-cache.ts', () => ({
	listPackageSkillsIndexes: state.indexes,
}))
vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	readPublishedSourceSnapshot: state.snapshot,
	readPublishedSourceManifestSnapshot: state.manifest,
}))
vi.mock('#worker/authorization/authorize.ts', async (original) => ({
	...(await original<Record<string, unknown>>()),
	computeEffectivePermissions: state.permissions,
	checkPermission: () => ({ allowed: true }),
	authorize: state.authorize,
}))
vi.mock('#mcp/capabilities/repo/repo-open-session.ts', () => ({
	repoOpenSessionCapability: { handler: state.open },
}))
vi.mock('#mcp/capabilities/repo/repo-commit.ts', () => ({
	repoCommitCapability: { handler: state.commit },
}))
vi.mock('#mcp/capabilities/repo/repo-run-checks.ts', () => ({
	repoRunChecksCapability: { handler: state.checks },
}))
vi.mock('#mcp/capabilities/repo/repo-publish-session.ts', () => ({
	repoPublishSessionCapability: { handler: state.publish },
}))
vi.mock('#mcp/capabilities/repo/repo-discard-session.ts', () => ({
	repoDiscardSessionCapability: { handler: state.discard },
}))
vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: () => ({ restorePublishedSkill: state.restore }),
}))
import { loadSkillHistory, restoreSkillVersion } from './skill-history.ts'
const skill = 'skill://team/docs/writing/SKILL.md'
const data = { orgSlug: 'team', skill }
beforeEach(async () => {
	vi.resetAllMocks()
	state.scope.mockResolvedValue({
		bindings: {},
		request: new Request('https://kody.test/skills'),
		user: { mcpUser: null, request: { org: { id: 'org' } } },
	})
	const resources = async (text: string) => [
		{
			uri: skill,
			relativePath: 'SKILL.md',
			packagePath: 'skills/writing/SKILL.md',
			mimeType: 'text/markdown',
			...(await digestSnapshotContent(text, 'skills/writing/SKILL.md')),
		},
	]
	const latest = {
		packageId: 'pkg',
		kodyId: '@team/docs',
		publishedCommit: 'new',
		skills: [
			{
				uri: skill,
				name: 'writing',
				resources: await resources('New instructions\n'),
			},
		],
	}
	const old = {
		...latest,
		publishedCommit: 'old',
		skills: [
			{
				uri: skill,
				name: 'writing',
				resources: await resources('Old instructions\n'),
			},
		],
	}
	state.catalog.mockResolvedValue([
		{ ownerUserId: 'org', sourceId: 'source', packageId: 'pkg', index: latest },
	])
	state.indexes.mockResolvedValue([old, latest])
	state.snapshot.mockImplementation(async ({ publishedCommit }) => ({
		files: {
			'skills/writing/SKILL.md':
				publishedCommit === 'new' ? 'New instructions\n' : 'Old instructions\n',
		},
	}))
	state.manifest.mockImplementation(async ({ publishedCommit }) => ({
		createdAt:
			publishedCommit === 'new'
				? '2026-10-28T12:00:00Z'
				: '2026-10-27T12:00:00Z',
	}))
	state.open.mockResolvedValue({ id: 'session', base_commit: 'new' })
	state.restore.mockResolvedValue({ changed: true })
	state.checks.mockResolvedValue({ ok: true, results: [] })
	state.publish.mockResolvedValue({ status: 'ok', message: 'Published' })
})
test('compares archived published files and binds reads to the signed-in org', async () => {
	const result = await loadSkillHistory({ data })
	expect(result.versions.map((entry) => entry.commit)).toEqual(['new', 'old'])
	expect(result.changes).toEqual([
		{ added: false, removed: true, value: 'Old instructions\n' },
		{ added: true, removed: false, value: 'New instructions\n' },
	])
	expect(state.scope).toHaveBeenCalledWith(
		expect.objectContaining({ orgSlug: 'team', section: 'skills' }),
	)
	expect(state.snapshot).toHaveBeenCalledWith(
		expect.objectContaining({ sourceId: 'source', publishedCommit: 'old' }),
	)
})
test('rejects inaccessible skills and commits outside this package archive', async () => {
	await expect(
		loadSkillHistory({ data: { ...data, commit: 'other-package' } }),
	).rejects.toBeDefined()
	expect(state.snapshot).not.toHaveBeenCalled()
	state.catalog.mockResolvedValue([])
	await expect(loadSkillHistory({ data })).rejects.toBeDefined()
})
test('detects corrupted historical content instead of displaying it', async () => {
	state.snapshot.mockResolvedValue({
		files: { 'skills/writing/SKILL.md': 'tampered' },
	})
	await expect(loadSkillHistory({ data })).rejects.toThrow('does not match')
})
test('requires write permission and refuses stale restores before editing', async () => {
	state.authorize.mockRejectedValueOnce(new Error('Forbidden'))
	await expect(
		restoreSkillVersion({
			data: { ...data, commit: 'old', expectedCommit: 'new' },
		}),
	).rejects.toThrow('Forbidden')
	expect(state.open).not.toHaveBeenCalled()
	await expect(
		restoreSkillVersion({
			data: { ...data, commit: 'old', expectedCommit: 'stale' },
		}),
	).rejects.toThrow('package changed')
	expect(state.restore).not.toHaveBeenCalled()
})
test('restores through a fresh checked publish and cleans up its editing session', async () => {
	const result = await restoreSkillVersion({
		data: { ...data, commit: 'old', expectedCommit: 'new' },
	})
	expect(result.ok).toBe(true)
	expect(state.restore).toHaveBeenCalledWith({
		sessionId: 'session',
		userId: 'org',
		commit: 'old',
		name: 'writing',
	})
	expect(state.checks).toHaveBeenCalledWith(
		{ session_id: 'session' },
		expect.anything(),
	)
	expect(state.checks.mock.invocationCallOrder[0]).toBeLessThan(
		state.publish.mock.invocationCallOrder[0]!,
	)
	expect(state.publish).toHaveBeenCalledWith(
		{ session_id: 'session' },
		expect.anything(),
	)
	expect(state.discard).toHaveBeenCalledWith(
		{ session_id: 'session' },
		expect.anything(),
	)
})
test('refuses a package that changes while its editing session opens', async () => {
	state.open.mockResolvedValue({ id: 'session', base_commit: 'newer' })
	await expect(
		restoreSkillVersion({
			data: { ...data, commit: 'old', expectedCommit: 'new' },
		}),
	).rejects.toThrow('package changed')
	expect(state.restore).not.toHaveBeenCalled()
	expect(state.discard).toHaveBeenCalled()
})

test('keeps the paused revision available when publishing requires approval', async () => {
	state.publish.mockResolvedValue({
		status: 'locked',
		message: 'Approval required',
		approval_url: 'https://kody.test/approve',
	})
	const result = await restoreSkillVersion({
		data: { ...data, commit: 'old', expectedCommit: 'new' },
	})
	expect(result).toEqual({
		ok: false,
		message: 'Approval required',
		approvalUrl: 'https://kody.test/approve',
	})
	expect(state.discard).not.toHaveBeenCalled()
})

test('does not report a published restore as failed when cleanup fails', async () => {
	state.discard.mockRejectedValue(new Error('Cleanup unavailable'))
	const error = vi.spyOn(console, 'error').mockImplementation(() => {})
	try {
		await expect(
			restoreSkillVersion({
				data: { ...data, commit: 'old', expectedCommit: 'new' },
			}),
		).resolves.toMatchObject({ ok: true })
	} finally {
		error.mockRestore()
	}
})

test('does not publish a restored revision when its checks fail', async () => {
	state.checks.mockResolvedValue({
		ok: false,
		results: [{ ok: false, message: 'Invalid skill frontmatter' }],
	})
	await expect(
		restoreSkillVersion({
			data: { ...data, commit: 'old', expectedCommit: 'new' },
		}),
	).rejects.toThrow('Publish checks failed: Invalid skill frontmatter')
	expect(state.publish).not.toHaveBeenCalled()
	expect(state.discard).toHaveBeenCalled()
})

test('does not commit or publish when the archived skill already matches', async () => {
	state.restore.mockResolvedValue({ changed: false })
	await expect(
		restoreSkillVersion({
			data: { ...data, commit: 'old', expectedCommit: 'new' },
		}),
	).rejects.toThrow('matches the current one')
	expect(state.commit).not.toHaveBeenCalled()
	expect(state.publish).not.toHaveBeenCalled()
	expect(state.discard).toHaveBeenCalled()
})
