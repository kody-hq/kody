import { beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
	authorize: vi.fn(),
	read: vi.fn(),
	readDetail: vi.fn(),
}))

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
vi.mock('../../src/admin/orgs-data.ts', () => ({
	readAdminOrgsData: state.read,
	loadAdminOrgDetail: state.readDetail,
}))
vi.mock('./document-head.ts', () => ({
	loadDocumentHead: (key: string) => ({ title: key }),
}))

import { loadAdminOrg, loadAdminOrgs } from './admin-orgs.ts'

beforeEach(() => {
	vi.clearAllMocks()
	state.authorize.mockResolvedValue({
		bindings: { APP_DB: 'db' },
		user: { id: 1 },
	})
	state.read.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 })
	state.readDetail.mockResolvedValue({ org: { slug: 'blue-team' } })
})

test('organization list authorizes then loads typed filter data', async () => {
	const data = {
		query: 'blue',
		status: 'live',
		kind: 'team',
		page: 1,
		pageSize: 20,
		returnTo: '/admin/orgs?q=blue',
	} as const
	const result = await loadAdminOrgs({ data })
	expect(state.authorize).toHaveBeenCalledWith(data.returnTo)
	expect(state.read).toHaveBeenCalledWith('db', data)
	expect(result).toMatchObject({ forbidden: false })
})

test('organization detail authorizes, loads by slug, and returns forbidden for non-admins', async () => {
	const data = {
		slug: '@blue-team',
		returnTo: '/admin/orgs/%40blue-team',
	}
	expect(await loadAdminOrg({ data })).toMatchObject({ forbidden: false })
	expect(state.readDetail).toHaveBeenCalledWith(
		{ APP_DB: 'db' },
		{ slug: '@blue-team' },
	)

	state.authorize.mockResolvedValue({ bindings: {}, user: null })
	expect(await loadAdminOrg({ data })).toMatchObject({ forbidden: true })
	expect(state.readDetail).toHaveBeenCalledTimes(1)
})

test('forbidden organization list never reads org data and rejects unsafe destinations', async () => {
	state.authorize.mockResolvedValue({ bindings: {}, user: null })
	const input = {
		query: '',
		status: 'live',
		kind: 'all',
		page: 1,
		pageSize: 20,
		returnTo: '/admin/orgs',
	} as const
	expect(await loadAdminOrgs({ data: input })).toMatchObject({
		forbidden: true,
	})
	expect(state.read).not.toHaveBeenCalled()
	expect(() =>
		loadAdminOrgs({
			data: { ...input, returnTo: '//invalid.example/admin/orgs' },
		}),
	).toThrow(/Invalid string/)
	expect(state.authorize).toHaveBeenCalledTimes(1)
})
