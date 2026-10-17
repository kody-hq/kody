import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as authenticatedUserModule from '#app/authenticated-user.ts'
import type * as memoryRepo from '#mcp/memory/repo.ts'
import type * as memoryService from '#mcp/memory/service.ts'
import { buildMemoriesExportFilename } from '#universal/memory-export.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

const mockModule = vi.hoisted(() => {
	const memoryRow = {
		id: '11111111-1111-4111-8111-111111111111',
		category: 'preferences',
		status: 'active' as const,
		subject: 'Favorite editor',
		summary: 'Prefers VS Code for TypeScript work.',
		details: 'Uses the Remix extension and oxlint.',
		tags: ['editor', 'typescript'],
		sourceUris: ['https://example.com/notes/editor'],
		dedupeKey: 'prefs:editor',
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		lastAccessedAt: null as string | null,
		deletedAt: null as string | null,
	}
	const memoryDbRow = {
		id: memoryRow.id,
		user_id: 'stable-user-1' as OwnerId,
		category: memoryRow.category,
		status: memoryRow.status,
		subject: memoryRow.subject,
		summary: memoryRow.summary,
		details: memoryRow.details,
		tags_json: JSON.stringify(memoryRow.tags),
		source_uris_json: JSON.stringify(memoryRow.sourceUris),
		dedupe_key: memoryRow.dedupeKey,
		created_at: memoryRow.createdAt,
		updated_at: memoryRow.updatedAt,
		last_accessed_at: memoryRow.lastAccessedAt,
		deleted_at: memoryRow.deletedAt,
	}
	return {
		memoryRow,
		memoryDbRow,
		readAuthenticatedAppUser: vi.fn<
			typeof authenticatedUserModule.readAuthenticatedAppUser
		>(async () => ({
			sessionUserId: '42',
			userId: 42,
			username: 'test-user',
			email: 'user@example.com',
			emailVerified: true,
			emailVerificationDelivery: null,
			displayName: 'user',
			roles: ['user'],
			permissions: [],
			artifactOwnerIds: [],
			mcpUser: {
				userId: personIdFromStored('stable-user-1'),
				email: 'user@example.com',
				username: 'test-user',
				displayName: 'user',
			},
			request: sessionRequestContext('stable-user-1'),
		})),
		readAuthSessionResult: async () => ({ session: null, setCookie: null }),
		listMemoriesByUserId: vi.fn<typeof memoryRepo.listMemoriesByUserId>(
			async () => [memoryDbRow],
		),
		listMemoriesByUserIdPage: vi.fn<typeof memoryRepo.listMemoriesByUserIdPage>(
			async () => [memoryDbRow],
		),
		getMemory: vi.fn<typeof memoryService.getMemory>(async () => memoryRow),
		deleteMemory: vi.fn<typeof memoryService.deleteMemory>(async () => ({
			...memoryRow,
			status: 'deleted' as const,
		})),
	}
})

const { memoryRow } = mockModule

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof authenticatedUserModule.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: () => mockModule.readAuthSessionResult(),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: () => new Response(null, { status: 302 }),
	redirectToLoginWhenUnauthenticated: () => new Response(null, { status: 302 }),
}))

vi.mock('#mcp/memory/repo.ts', () => ({
	listMemoriesByUserId: (
		...args: Parameters<typeof memoryRepo.listMemoriesByUserId>
	) => mockModule.listMemoriesByUserId(...args),
	listMemoriesByUserIdPage: (
		...args: Parameters<typeof memoryRepo.listMemoriesByUserIdPage>
	) => mockModule.listMemoriesByUserIdPage(...args),
}))

vi.mock('#mcp/memory/service.ts', () => ({
	getMemory: (...args: Parameters<typeof memoryService.getMemory>) =>
		mockModule.getMemory(...args),
	deleteMemory: (...args: Parameters<typeof memoryService.deleteMemory>) =>
		mockModule.deleteMemory(...args),
}))

vi.mock('#worker/orgs/is-personal-org.ts', () => ({
	isPersonalOrg: async (_db: unknown, orgId: string) =>
		orgId === 'stable-user-1',
}))

const { testAccountMemoriesApiHandler } =
	await import('./account-memories.test-support.ts')

const { createAccountMemoriesExportHandler } =
	await import('../../../start/server/memories-export.ts')
const exportOrgBinding = vi.hoisted(() => vi.fn())
vi.mock('#worker/orgs/repo.ts', () => ({
	loadOrgBindingForSlug: exportOrgBinding,
}))

const env = { APP_DB: {} as D1Database } as Env

function createClient(
	createHandler: typeof testAccountMemoriesApiHandler,
	path: string,
) {
	const { execute } = createHandler(env)
	return (search = '', init?: RequestInit) =>
		execute({
			request: new Request(`https://example.com${path}${search}`, init),
			params: {},
		} as never)
}

const postJson = (body: Record<string, unknown>): RequestInit => ({
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify(body),
})

test('memories API lists, filters, and selects user-scoped memories', async () => {
	const request = createClient(
		testAccountMemoriesApiHandler,
		'/account/memories.json',
	)

	const listResponse = await request()
	expect(listResponse.status).toBe(200)
	expect(mockModule.listMemoriesByUserId).toHaveBeenCalledWith(
		expect.anything(),
		'stable-user-1',
		expect.objectContaining({
			statuses: ['active', 'archived'],
			includeDeleted: false,
			limit: 100,
		}),
	)
	expect(listResponse.data).toEqual({
		ok: true,
		email: 'user@example.com',
		username: 'test-user',
		memories: [
			{
				id: memoryRow.id,
				subject: memoryRow.subject,
				category: memoryRow.category,
				status: memoryRow.status,
				tags: memoryRow.tags,
				summary: memoryRow.summary,
				updatedAt: memoryRow.updatedAt,
			},
		],
		selectedMemory: null,
		query: '',
		includeDeleted: false,
		legacyReadOnly: false,
	})

	const filtered = await request(
		`?q=editor&includeDeleted=true&selected=${memoryRow.id}`,
	)
	expect(filtered.status).toBe(200)
	expect(mockModule.listMemoriesByUserId).toHaveBeenCalledWith(
		expect.anything(),
		'stable-user-1',
		expect.objectContaining({
			statuses: ['active', 'archived', 'deleted'],
			includeDeleted: true,
		}),
	)
	expect(mockModule.getMemory).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('stable-user-1'),
			memoryId: memoryRow.id,
			includeDeleted: true,
		}),
	)
	expect(filtered.data).toMatchObject({
		ok: true,
		query: 'editor',
		includeDeleted: true,
		selectedMemory: expect.objectContaining({
			id: memoryRow.id,
			details: memoryRow.details,
			sourceUris: memoryRow.sourceUris,
			dedupeKey: memoryRow.dedupeKey,
		}),
	})
	await request(`?selected=${memoryRow.id}`)
	expect(mockModule.getMemory).toHaveBeenLastCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('stable-user-1'),
			memoryId: memoryRow.id,
			includeDeleted: false,
		}),
	)
})

test('memories API soft/force deletes and rejects invalid delete requests', async () => {
	const request = createClient(
		testAccountMemoriesApiHandler,
		'/account/memories.json',
	)

	for (const force of [false, true]) {
		const response = await request(
			'',
			postJson({
				action: 'delete',
				memoryId: memoryRow.id,
				...(force ? { force } : {}),
			}),
		)
		expect([force, response.status]).toEqual([force, 200])
		expect(mockModule.deleteMemory).toHaveBeenLastCalledWith(
			expect.objectContaining({
				userId: ownerIdFromStored('stable-user-1'),
				memoryId: memoryRow.id,
				force,
			}),
		)
	}

	const rejections = [
		[{ action: 'delete' }, 400],
		[{ action: 'upsert' }, 400],
		[{ action: 'delete', memoryId: 'missing' }, 404],
	] as const
	for (const [body, status] of rejections) {
		if (status === 404)
			mockModule.deleteMemory.mockResolvedValueOnce(null as never)
		const response = await request('', postJson(body))
		expect([body, response.status]).toEqual([body, status])
	}
})

test('memories export filename uses the UTC calendar date', () => {
	expect(
		buildMemoriesExportFilename(new Date('2026-08-31T23:30:00.000Z')),
	).toBe('kody-memories-2026-08-31.json')
})

test('memories export supports authenticated HEAD without a response body', async () => {
	const response = await createAccountMemoriesExportHandler(env)({
		request: new Request('https://example.com/account/memories-export.json', {
			method: 'HEAD',
		}),
	})
	expect(response.status).toBe(200)
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	expect(response.headers.get('Content-Disposition')).toContain('attachment;')
	expect(await response.text()).toBe('')
})

test('memories export downloads the signed-in user memories as JSON', async () => {
	const request = createExportClient(
		createAccountMemoriesExportHandler,
		'/account/memories-export.json',
	)

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null as never)
	expect((await request()).status).toBe(401)

	const defaultExport = await request()
	expect(defaultExport.status).toBe(200)
	expect(defaultExport.headers.get('Cache-Control')).toBe('no-store')
	expect(defaultExport.headers.get('Content-Type')).toBe(
		'application/json; charset=utf-8',
	)
	expect(defaultExport.headers.get('Content-Disposition')).toMatch(
		/^attachment; filename="kody-memories-\d{4}-\d{2}-\d{2}\.json"$/,
	)
	expect(mockModule.listMemoriesByUserIdPage).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('stable-user-1'),
			afterId: null,
			statuses: ['active', 'archived'],
			includeDeleted: false,
			limit: 200,
		}),
	)
	const payload = (await defaultExport.json()) as {
		kind: string
		version: number
		exportedAt: string
		includeDeleted: boolean
		memories: Array<Record<string, unknown>>
	}
	expect(payload.kind).toBe('kody-memories')
	expect(payload.version).toBe(1)
	expect(payload.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
	expect(payload.includeDeleted).toBe(false)
	expect(payload.memories).toEqual([
		{
			id: memoryRow.id,
			subject: memoryRow.subject,
			category: memoryRow.category,
			status: memoryRow.status,
			tags: memoryRow.tags,
			summary: memoryRow.summary,
			details: memoryRow.details,
			sourceUris: memoryRow.sourceUris,
			dedupeKey: memoryRow.dedupeKey,
			createdAt: memoryRow.createdAt,
			updatedAt: memoryRow.updatedAt,
			lastAccessedAt: memoryRow.lastAccessedAt,
			deletedAt: memoryRow.deletedAt,
		},
	])
	expect(JSON.stringify(payload)).not.toContain('user@example.com')
	expect(JSON.stringify(payload)).not.toContain('stable-user-1')
	expect(payload.memories[0]).not.toHaveProperty('user_id')
	expect(payload.memories[0]).not.toHaveProperty('userId')

	const withDeleted = await request('?includeDeleted=true')
	expect(withDeleted.status).toBe(200)
	expect(mockModule.listMemoriesByUserIdPage).toHaveBeenLastCalledWith(
		expect.objectContaining({
			statuses: ['active', 'archived', 'deleted'],
			includeDeleted: true,
		}),
	)
	await expect(withDeleted.json()).resolves.toMatchObject({
		includeDeleted: true,
	})

	mockModule.listMemoriesByUserIdPage.mockClear()
	const firstPage = Array.from({ length: 200 }, (_, index) => ({
		...mockModule.memoryDbRow,
		id: `page-1-${String(index).padStart(3, '0')}`,
	}))
	mockModule.listMemoriesByUserIdPage
		.mockResolvedValueOnce(firstPage)
		.mockResolvedValueOnce([{ ...mockModule.memoryDbRow, id: 'page-2-000' }])
	const pagedPayload = (await (await request()).json()) as {
		memories: Array<{ id: string }>
	}
	expect(pagedPayload.memories).toHaveLength(201)
	expect(pagedPayload.memories.at(-1)?.id).toBe('page-2-000')
	expect(mockModule.listMemoriesByUserIdPage).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({
			afterId: 'page-1-199',
		}),
	)

	expect((await request('', { method: 'POST' })).status).toBe(405)
})

function createExportClient(
	createHandler: typeof createAccountMemoriesExportHandler,
	path: string,
) {
	const handler = createHandler(env)
	return (search = '', init?: RequestInit) =>
		handler({
			request: new Request(`https://example.com${path}${search}`, init),
			params: {},
		} as never)
}

test('accepted memory deletion does not depend on listing memories', async () => {
	const request = createClient(
		testAccountMemoriesApiHandler,
		'/account/memories.json',
	)
	const original = mockModule.listMemoriesByUserId.getMockImplementation()
	mockModule.listMemoriesByUserId.mockRejectedValue(
		new Error('Page unavailable'),
	)
	mockModule.listMemoriesByUserId.mockClear()
	mockModule.deleteMemory.mockResolvedValueOnce({
		...memoryRow,
		status: 'deleted',
	})
	try {
		const response = await request(
			'',
			postJson({ action: 'delete', memoryId: memoryRow.id }),
		)
		expect(response.status).toBe(200)
		expect(response.data).toEqual({ ok: true, deletedMemoryId: memoryRow.id })
		expect(mockModule.listMemoriesByUserId).not.toHaveBeenCalled()
	} finally {
		mockModule.listMemoriesByUserId.mockImplementation(original!)
	}
})

test('memories download rejects invalid, missing, and grant-only explicit org scopes before querying memories', async () => {
	const request = createExportClient(
		createAccountMemoriesExportHandler,
		'/account/memories-export.json',
	)
	for (const binding of [
		null,
		{ org: { id: 'org-team', slug: 'team' }, role: null },
	]) {
		exportOrgBinding.mockResolvedValueOnce(binding)
		mockModule.listMemoriesByUserIdPage.mockClear()
		expect((await request('?org=team')).status).toBe(404)
		expect(mockModule.listMemoriesByUserIdPage).not.toHaveBeenCalled()
	}
	mockModule.listMemoriesByUserIdPage.mockClear()
	expect((await request('?org=%20')).status).toBe(404)
	expect(mockModule.listMemoriesByUserIdPage).not.toHaveBeenCalled()
})
test('memories download explicitly binds a normalized member org, without relying on auth URL binding', async () => {
	exportOrgBinding.mockResolvedValueOnce({
		org: { id: 'org-team', slug: 'team' },
		role: 'member',
	})
	const request = createExportClient(
		createAccountMemoriesExportHandler,
		'/account/memories-export.json',
	)
	expect((await request('?org=%20TEAM%20&includeDeleted=true')).status).toBe(
		200,
	)
	expect(exportOrgBinding).toHaveBeenLastCalledWith(
		env.APP_DB,
		'stable-user-1',
		'team',
	)
	expect(mockModule.listMemoriesByUserIdPage).toHaveBeenLastCalledWith(
		expect.objectContaining({
			userId: 'org-team',
			statuses: ['active', 'archived', 'deleted'],
			includeDeleted: true,
		}),
	)
})

test('memories download authenticates the original session independently of the explicit org query', async () => {
	const request = new Request(
		'https://example.com/account/memories-export.json?org=team',
		{ headers: { cookie: 'session=original' } },
	)
	exportOrgBinding.mockResolvedValueOnce(null)
	expect(
		(await createAccountMemoriesExportHandler(env)({ request })).status,
	).toBe(404)
	const args = mockModule.readAuthenticatedAppUser.mock.calls.at(-1)!
	expect(args[0]).toBe(request)
	expect(args[2]?.resourceRequest?.url).toBe('https://example.com/')
})
