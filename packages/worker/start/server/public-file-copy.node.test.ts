import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	scope: vi.fn(),
	read: vi.fn(),
	write: vi.fn(),
	user: 'person_viewer',
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => ({
		validator: () => ({ handler: (handler: unknown) => handler }),
	}),
}))
vi.mock('./mutation-context.ts', () => ({
	withWebsiteMutation: async (_: unknown, run: (ctx: unknown) => unknown) =>
		run({
			env: { SECRET_STORE_KEY: 'test-only-key' },
			user: {
				mcpUser: { userId: state.user },
				request: { org: { id: 'org_wrong' } },
			},
		}),
}))
vi.mock('../../src/orgs/repo.ts', () => ({
	loadOrgBindingForPerson: async () => ({
		org: { id: 'org_personal', slug: 'viewer' },
	}),
}))
vi.mock('../../src/request-context/request-context.ts', () => ({
	deriveRequestContext: ({ orgBinding }: { orgBinding: unknown }) => orgBinding,
}))
vi.mock('../../src/files/public-links.ts', () => ({
	resolvePublicFileScope: state.scope,
	readScopedPublishedFile: async (
		_env: unknown,
		_owner: unknown,
		file: unknown,
	) => file,
}))
vi.mock('../../src/files/feature.ts', () => ({
	fileCollaborationEnabled: async () => true,
}))
vi.mock('../../src/files/client.ts', () => ({
	fileStoreRpc: () => ({ read: state.read }),
}))
vi.mock('../../src/files/service.ts', () => ({ writeFile: state.write }))
vi.mock('../../src/app/website-capability.ts', () => ({
	websiteCapabilityContext: (value: {
		env: unknown
		user: { mcpUser: unknown; request: unknown }
	}) => ({
		...value,
		callerContext: { user: value.user.mcpUser, request: value.user.request },
	}),
}))
import {
	preparePublicFileCopy,
	copyPublicFileStep,
} from './public-file-copy.ts'
import {
	copyPageContent,
	sealPublicCopyPlan,
	openPublicCopyPlan,
} from '../../src/files/public-copy.ts'
const cryptoEnv = { SECRET_STORE_KEY: 'test-only-key' }

const root = '11111111-1111-4111-8111-111111111111',
	child = '22222222-2222-4222-8222-222222222222',
	asset = '33333333-3333-4333-8333-333333333333',
	revision = '44444444-4444-4444-8444-444444444444',
	block = '55555555-5555-4555-8555-555555555555'
const source = {
	orgSlug: 'source',
	rootId: root,
	itemId: root,
	token: 'a'.repeat(64),
}
const files = [
	{ id: root, name: 'Launch', mediaType: 'application/vnd.kody.page+json' },
	{ id: child, name: 'Notes.md', parentId: root, mediaType: 'text/markdown' },
	{ id: asset, name: 'Logo.svg', mediaType: 'image/svg+xml' },
]
const content = JSON.stringify({
	version: 1,
	blocks: [{ id: block, kind: 'file', fileId: asset }],
})
beforeEach(() => {
	vi.clearAllMocks()
	state.user = 'person_viewer'
	state.scope.mockImplementation(async (_env, _slug, _root, _token, id) => ({
		ownerId: 'org_source',
		files: files.map((file) => ({
			...file,
			revisionId: revision,
			content: file.id === root ? content : 'notes',
		})),
		file: {
			...files.find((file) => file.id === id),
			revisionId: revision,
			content: id === root ? content : 'notes',
		},
	}))
	state.read.mockImplementation(async (_owner, id) => ({
		content: id === root ? content : 'notes',
	}))
	state.write.mockResolvedValue({ ok: true })
})
test('copy plans include descendants and shared page assets, bind to the personal workspace, and pin immutable revisions', async () => {
	const plan = await preparePublicFileCopy({ data: source })
	expect(plan.count).toBe(3)
	const sealed = await openPublicCopyPlan(
		cryptoEnv,
		'org_personal',
		'person_viewer',
		plan.ticket,
	)
	expect(sealed.entries[0]).toMatchObject({
		sourceId: root,
		revisionId: revision,
	})
	expect(sealed.entries[1]!.parentId).toBe(sealed.entries[0]!.targetId)
	await copyPublicFileStep({ data: { ticket: plan.ticket, index: 0 } })
	expect(state.read).toHaveBeenCalledWith('org_source', root, revision)
	const [ctx, input] = state.write.mock.calls[0]!
	expect(ctx.user.request.org.id).toBe('org_personal')
	expect(JSON.parse(input.content).blocks[0].fileId).toBe(
		sealed.entries.find((entry) => entry.sourceId === asset)!.targetId,
	)
	expect(input).not.toHaveProperty('access_mode')
	await copyPublicFileStep({ data: { ticket: plan.ticket, index: 0 } })
	expect(state.write.mock.calls[1]![1]).toEqual(input)
})
test('revoked links, edited tickets, another viewer and expired plans fail before writing', async () => {
	const plan = await preparePublicFileCopy({ data: source })
	state.scope.mockRejectedValueOnce(new Error('Shared file unavailable.'))
	await expect(
		copyPublicFileStep({ data: { ticket: plan.ticket, index: 0 } }),
	).rejects.toThrow('unavailable')
	await expect(
		copyPublicFileStep({
			data: { ticket: plan.ticket.slice(0, -10) + 'tampered', index: 0 },
		}),
	).rejects.toThrow()
	state.user = 'person_other'
	await expect(
		copyPublicFileStep({ data: { ticket: plan.ticket, index: 0 } }),
	).rejects.toThrow()
	state.user = 'person_viewer'
	const payload = await openPublicCopyPlan(
		cryptoEnv,
		'org_personal',
		'person_viewer',
		plan.ticket,
	)
	const ticket = await sealPublicCopyPlan(cryptoEnv, 'org_personal', {
		...payload,
		expires: 0,
	})
	await expect(
		copyPublicFileStep({ data: { ticket, index: 0 } }),
	).rejects.toThrow('expired')
	expect(state.write).not.toHaveBeenCalled()
})
test('unshared embeds lose the reference rather than pointing at the original owner', () => {
	expect(JSON.parse(copyPageContent(content, [])).blocks[0]).toMatchObject({
		kind: 'paragraph',
		text: 'File not included in this shared copy.',
	})
})
