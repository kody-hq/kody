import type * as SkillsCatalog from '#mcp/skills/skills-catalog.ts'
import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	scope: vi.fn(),
	catalog: vi.fn(),
	read: vi.fn(),
	record: vi.fn(),
	authorize: vi.fn(),
	saved: vi.fn(),
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
vi.mock('#mcp/skills/skills-catalog.ts', async (importOriginal) => ({
	...(await importOriginal<typeof SkillsCatalog>()),
	loadCallerSkillsCatalog: state.catalog,
	readCatalogSkillResource: state.read,
}))
vi.mock('#worker/package-registry/skill-read-events.ts', async (original) => ({
	...(await original<Record<string, unknown>>()),
	recordSkillRead: state.record,
}))
vi.mock('#worker/package-registry/repo.ts', async (original) => ({
	...(await original<Record<string, unknown>>()),
	getSavedPackageById: state.saved,
}))
vi.mock('#worker/authorization/authorize.ts', async (original) => ({
	...(await original<Record<string, unknown>>()),
	authorize: state.authorize,
}))
vi.mock('#app/highlight-code.ts', () => ({
	highlightSnippets: async () => [],
	highlightMarkdownFences: async () => [],
}))
vi.mock('#app/skill-metrics.ts', () => ({
	loadSkillMetrics: vi
		.fn()
		.mockResolvedValue({ skillCount: 1, instructionReads: 0 }),
}))
import { loadSkillsPage, recordSkillPageRead } from './skills.ts'
import { issueSkillReadReceipt } from '#worker/package-registry/skill-read-events.ts'
const skill = 'skill://team/docs/writing/SKILL.md'
const file = 'skill://team/docs/writing/references/style.md'
beforeEach(() => {
	vi.clearAllMocks()
	state.scope.mockResolvedValue({
		bindings: {},
		request: new Request('https://kody.test/_serverFn/skills'),
		user: { mcpUser: null, request: { org: { id: 'team-id' } } },
	})
	state.catalog.mockResolvedValue([
		{
			packageId: 'package-1',
			index: {
				kodyId: '@team/docs',
				publishedCommit: 'commit-1',
				skills: [
					{
						uri: skill,
						name: 'writing',
						frontmatter: { description: 'Write clearly.' },
						resources: [
							{ uri: skill, relativePath: 'SKILL.md', size: 10 },
							{ uri: file, relativePath: 'references/style.md', size: 20 },
						],
					},
				],
			},
		},
	])
	state.read.mockResolvedValue({
		contents: [{ uri: file, mimeType: 'text/markdown', text: '# Style' }],
	})
})
test('uses the authenticated organization context without an MCP flag gate', async () => {
	const result = await loadSkillsPage({ data: { orgSlug: 'team' } })
	expect(state.scope).toHaveBeenCalledWith({
		orgSlug: 'team',
		section: 'skills',
		returnTo: '/@team/-/skills',
	})
	expect(state.catalog).toHaveBeenCalledWith(
		expect.objectContaining({
			failOnError: true,
			callerContext: expect.objectContaining({
				request: { org: { id: 'team-id' } },
			}),
		}),
	)
	expect(result.skills[0]).toMatchObject({
		name: 'writing',
		packageName: '@team/docs',
	})
	expect(state.read).not.toHaveBeenCalled()
})
test('reads instructions by default and supporting files on selection', async () => {
	await loadSkillsPage({ data: { orgSlug: 'team', skill } })
	expect(state.read).toHaveBeenLastCalledWith(
		expect.objectContaining({ uri: skill }),
	)
	const result = await loadSkillsPage({
		data: { orgSlug: 'team', skill, file },
	})
	expect(result.content).toMatchObject({ text: '# Style' })
	expect(state.read).toHaveBeenLastCalledWith(
		expect.objectContaining({ uri: file }),
	)
})
test('rejects unavailable skills and files outside the selected skill', async () => {
	await expect(
		loadSkillsPage({
			data: { orgSlug: 'team', skill: 'skill://other/private/secret/SKILL.md' },
		}),
	).rejects.toMatchObject({ isNotFound: true })
	await expect(
		loadSkillsPage({
			data: {
				orgSlug: 'team',
				skill,
				file: 'skill://team/docs/other/SKILL.md',
			},
		}),
	).rejects.toMatchObject({ isNotFound: true })
	expect(state.read).not.toHaveBeenCalled()
})
test('does not read a catalog when workspace access is denied', async () => {
	state.scope.mockRejectedValue(new Error('Organization unavailable'))
	await expect(loadSkillsPage({ data: { orgSlug: 'other' } })).rejects.toThrow(
		'Organization unavailable',
	)
	expect(state.catalog).not.toHaveBeenCalled()
})

test('view acknowledgement verifies actor and org, rechecks access, and keeps the displayed version', async () => {
	const resource = {
		packageId: 'pkg',
		packageName: '@team/docs',
		packageOwnerId: 'team-id',
		publishedCommit: 'displayed-version',
		skillName: 'writing',
		skillUri: skill,
		filePath: 'skills/writing/SKILL.md',
		digest: 'sha256:a',
		kind: 'instructions' as const,
	}
	const receipt = await issueSkillReadReceipt('test-secret', {
		resource,
		actorId: 'person-1',
		orgId: 'team-id',
		channel: 'skills-page',
	})
	const context = {
		bindings: { COOKIE_SECRET: 'test-secret' },
		request: new Request('https://kody.test/_serverFn/skills'),
		user: {
			mcpUser: null,
			request: { org: { id: 'team-id' }, actor: { userId: 'person-1' } },
		},
	}
	state.scope.mockResolvedValue(context)
	state.saved.mockResolvedValue({ id: 'pkg', userId: 'team-id' })
	const eventId = crypto.randomUUID()
	await recordSkillPageRead({ data: { orgSlug: 'team', receipt, eventId } })
	expect(state.authorize).toHaveBeenCalledWith(
		expect.anything(),
		'package:read',
		expect.anything(),
	)
	expect(state.record).toHaveBeenCalledWith(
		expect.objectContaining({ resource, eventId }),
	)
	state.record.mockClear()
	state.scope.mockResolvedValue({
		...context,
		user: {
			...context.user,
			request: { ...context.user.request, actor: { userId: 'person-2' } },
		},
	})
	await expect(
		recordSkillPageRead({ data: { orgSlug: 'team', receipt, eventId } }),
	).rejects.toBeDefined()
	state.scope.mockResolvedValue({
		...context,
		user: {
			...context.user,
			request: { ...context.user.request, org: { id: 'other-org' } },
		},
	})
	await expect(
		recordSkillPageRead({ data: { orgSlug: 'team', receipt, eventId } }),
	).rejects.toBeDefined()
	expect(state.record).not.toHaveBeenCalled()
	state.scope.mockResolvedValue(context)
	state.authorize.mockRejectedValueOnce(new Error('Permission revoked'))
	await expect(
		recordSkillPageRead({ data: { orgSlug: 'team', receipt, eventId } }),
	).rejects.toThrow('Permission revoked')
	expect(state.record).not.toHaveBeenCalled()
})
