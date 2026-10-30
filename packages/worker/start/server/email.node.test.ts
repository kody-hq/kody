import { beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
	readList: vi.fn(),
	readDetail: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let validate = (data: unknown) => data
		const builder = {
			validator: (fn: typeof validate) => {
				validate = fn
				return builder
			},
			handler:
				(run: (input: { data: unknown }) => unknown) =>
				(input: { data?: unknown } = {}) =>
					run({ data: validate(input.data) }),
		}
		return builder
	},
}))
vi.mock('./collection-context.ts', () => ({
	loadScopedCollection: async () => ({
		bindings: { APP_DB: {} },
		user: { request: { org: { id: 'team' } }, mcpUser: { userId: 'member' } },
	}),
	loadPersonalCollection: async () => {
		throw new Error('personal collection is not used by org email reads')
	},
}))
vi.mock('../../src/app/account-email-data.ts', () => ({
	readAccountEmailData: state.readList,
	loadAccountEmailDetail: state.readDetail,
}))
const { AuthorizationError } =
	await import('#worker/authorization/authorize.ts')
const { loadEmailList, loadEmailDetail } = await import('./email.ts')

const list = {
	org: 'team',
	query: '',
	view: 'inbox',
	page: 1,
	pageSize: 25,
} as const

function denial(code: 'missing_permission' | 'wrong_org') {
	return new AuthorizationError({
		code,
		permission: 'email:read',
		orgId: null,
		resource: null,
		message: 'Missing email:read.',
	})
}

beforeEach(() => {
	vi.resetAllMocks()
	state.readList.mockResolvedValue({ selectedMessage: null, messages: [] })
	state.readDetail.mockResolvedValue(null)
})

test('a member without email:read gets the missing-grant state, not an error', async () => {
	state.readList.mockRejectedValue(denial('missing_permission'))
	state.readDetail.mockRejectedValue(denial('missing_permission'))
	await expect(loadEmailList({ data: list })).resolves.toEqual({
		missingGrant: 'email:read',
	})
	await expect(
		loadEmailDetail({ data: { org: 'team', messageId: 'm1' } }),
	).resolves.toBeNull()
})

test('a member with email:read reads the mailbox', async () => {
	await expect(loadEmailList({ data: list })).resolves.toEqual({
		messages: [],
	})
	await loadEmailDetail({ data: { org: 'team', messageId: 'm1' } })
	expect(state.readDetail).toHaveBeenCalledWith(
		expect.objectContaining({ messageId: 'm1' }),
	)
})

test('other authorization failures and real errors still throw', async () => {
	state.readList.mockRejectedValue(denial('wrong_org'))
	await expect(loadEmailList({ data: list })).rejects.toBeInstanceOf(
		AuthorizationError,
	)
	state.readList.mockRejectedValue(
		new AuthorizationError({
			code: 'missing_permission',
			permission: 'billing:read',
			orgId: null,
			resource: null,
			message: 'Missing billing:read.',
		}),
	)
	await expect(loadEmailList({ data: list })).rejects.toBeInstanceOf(
		AuthorizationError,
	)
	state.readDetail.mockRejectedValue(new Error('D1 down'))
	await expect(
		loadEmailDetail({ data: { org: 'team', messageId: 'm1' } }),
	).rejects.toThrow('D1 down')
})
