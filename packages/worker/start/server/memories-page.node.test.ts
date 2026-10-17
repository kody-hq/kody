import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ scope: vi.fn(), read: vi.fn() }))
vi.mock('@tanstack/react-start', () => ({
	createServerOnlyFn: <T>(fn: T) => fn,
	createServerFn: () => {
		let parse = (value: unknown) => value
		const builder = {
			validator(
				schema:
					| { parse: (value: unknown) => unknown }
					| ((value: unknown) => unknown),
			) {
				parse =
					typeof schema === 'function' ? schema : schema.parse.bind(schema)
				return builder
			},
			handler(run: (input: { data: unknown }) => Promise<unknown>) {
				return async (input: { data: unknown }) =>
					run({ data: parse(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('./collection-context.ts', () => ({
	loadScopedCollection: state.scope,
}))
vi.mock('../../src/app/account-memories-data.ts', () => ({
	loadAccountMemoriesData: state.read,
}))
vi.mock('./document-head.ts', () => ({
	loadDocumentHead: () => ({ title: 'Memories' }),
}))
import { loadMemoriesPage } from './account-collections.ts'
beforeEach(() => {
	vi.clearAllMocks()
	state.scope.mockResolvedValue({
		bindings: { APP_DB: {} },
		user: { id: 'actor' },
	})
	state.read.mockResolvedValue({ ok: true, memories: [] })
})
test('memory reads use explicit organization, selection and filters without manufacturing a Request', async () => {
	await loadMemoriesPage({
		data: {
			orgSlug: 'team',
			memoryId: 'path-id',
			selected: 'query-id',
			query: 'meeting',
			includeDeleted: true,
		},
	})
	expect(state.scope).toHaveBeenCalledWith({
		orgSlug: 'team',
		section: 'memories',
		returnTo:
			'/@team/-/memories/path-id?selected=query-id&q=meeting&includeDeleted=true',
	})
	expect(state.read).toHaveBeenCalledWith({
		env: { APP_DB: {} },
		user: { id: 'actor' },
		query: 'meeting',
		includeDeleted: true,
		selectedMemoryId: 'path-id',
	})
})
test('denied organization reads never reach memory storage', async () => {
	state.scope.mockRejectedValue(new Error('Organization unavailable'))
	await expect(
		loadMemoriesPage({ data: { orgSlug: 'other' } }),
	).rejects.toThrow('Organization unavailable')
	expect(state.read).not.toHaveBeenCalled()
})
test('invalid organization identity is rejected before authentication or storage', async () => {
	await expect(
		loadMemoriesPage({ data: { orgSlug: '../other' } }),
	).rejects.toThrow(/orgSlug/)
	expect(state.scope).not.toHaveBeenCalled()
	expect(state.read).not.toHaveBeenCalled()
})
