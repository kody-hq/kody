import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ authorize: vi.fn(), read: vi.fn() }))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let parse = (input: unknown) => input
		const builder = {
			validator(schema: { parse(input: unknown): unknown }) {
				parse = (input) => schema.parse(input)
				return builder
			},
			handler(run: (input: { data: unknown }) => Promise<unknown>) {
				return (input: { data: unknown }) => run({ data: parse(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('./admin-page-context.ts', () => ({
	readAdminPageContext: state.authorize,
}))
vi.mock('../../src/admin/users-data.ts', () => ({
	readAdminUsersData: state.read,
}))
vi.mock('./document-head.ts', () => ({
	loadDocumentHead: (key: string) => ({ title: key }),
}))
import { loadAdminUsers } from './admin-users.ts'
const input = {
	query: 'ada',
	role: 'admin',
	verification: '',
	pageSize: 20,
	selectedStableUserId: 'a'.repeat(64),
	detail: true,
	returnTo: '/admin/users/other?q=ignored&page=9&selected=ignored',
}
beforeEach(() => {
	vi.clearAllMocks()
	state.authorize.mockResolvedValue({
		bindings: { APP_DB: 'db' },
		user: { id: 1 },
	})
	state.read.mockResolvedValue({ users: [] })
})
test('user read uses typed selection and filters, not the auth return URL', async () => {
	await loadAdminUsers({ data: input })
	expect(state.authorize).toHaveBeenCalledWith(input.returnTo)
	expect(state.read).toHaveBeenCalledWith(
		{ APP_DB: 'db' },
		{
			query: input.query,
			role: input.role,
			verification: input.verification,
			pageSize: input.pageSize,
			selectedStableUserId: input.selectedStableUserId,
			page: 1,
		},
	)
})
test('forbidden page never loads admin records', async () => {
	state.authorize.mockResolvedValue({ bindings: {}, user: null })
	expect(await loadAdminUsers({ data: input })).toMatchObject({
		forbidden: true,
	})
	expect(state.read).not.toHaveBeenCalled()
})
test('rejects external or non-admin return destinations before authorization', async () => {
	for (const returnTo of [
		'//evil.test/admin/users',
		'/account',
		'/admin/users\\evil',
	]) {
		await expect(async () =>
			loadAdminUsers({ data: { ...input, returnTo } }),
		).rejects.toThrow()
	}
	expect(state.authorize).not.toHaveBeenCalled()
})
