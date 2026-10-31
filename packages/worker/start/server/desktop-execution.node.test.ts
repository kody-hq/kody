import { beforeEach, expect, test, vi } from 'vitest'
import {
	pageFixture,
	contextFixture,
} from '../test-support/execution-contexts-fixtures.ts'
const state = vi.hoisted(() => ({
	signedIn: true,
	username: 'jane',
	page: vi.fn(),
	set: vi.fn(),
	mutation: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let schema: { parse: (input: unknown) => unknown }
		const builder = {
			validator(value: typeof schema) {
				schema = value
				return builder
			},
			inputValidator(value: (input: unknown) => unknown) {
				schema = { parse: value }
				return builder
			},
			handler(fn: (input: { data: unknown }) => unknown) {
				return (input: { data: unknown }) =>
					fn({ data: schema.parse(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('./mutation-context.ts', () => ({
	withWebsiteMutation: (
		options: unknown,
		write: (input: unknown) => unknown,
	) => {
		state.mutation(options)
		if (!state.signedIn) throw new Error('Please sign in again.')
		return write({
			env: {},
			request: new Request('https://kody.test'),
			user: { username: state.username },
		})
	},
}))
vi.mock('../../src/app/handlers/execution-contexts.ts', () => ({
	loadExecutionContextsPageData: state.page,
	setExecutionChainForUser: state.set,
}))
import { putDesktopExecutionFirst } from './execution-contexts.ts'
const data = { orgSlug: 'jane', username: 'jane', contextId: 'ec_laptop' }
beforeEach(() => {
	vi.clearAllMocks()
	state.signedIn = true
	state.username = 'jane'
	state.page.mockResolvedValue({
		...pageFixture({ personalOrg: true, contexts: [contextFixture()] }),
		chain: {
			entries: [{ kind: 'cloud' }],
			strict: false,
			updatedAt: 'test-revision',
			updatedBy: 'jane',
		},
	})
	state.set.mockResolvedValue({ ok: true, chain: {}, unutilized: null })
})
test('private desktop chain setup authenticates, scopes the mutation, and uses the current chain version', async () => {
	await putDesktopExecutionFirst({ data })
	expect(state.mutation).toHaveBeenCalledWith({
		scope: { orgSlug: 'jane', requireMembership: false },
	})
	expect(state.set).toHaveBeenCalledWith(
		expect.objectContaining({
			orgSlug: 'jane',
			ifMatch: 'test-revision',
			entries: expect.arrayContaining([{ kind: 'context', id: 'ec_laptop' }]),
		}),
	)
	expect(state.set.mock.calls[0]![0].entries[0]).toEqual({
		kind: 'context',
		id: 'ec_laptop',
	})
})
test('signed-out, switched-account, foreign, and revoked registrations cannot update a chain', async () => {
	state.signedIn = false
	await expect(putDesktopExecutionFirst({ data })).rejects.toThrow('sign in')
	state.signedIn = true
	state.username = 'sam'
	await expect(putDesktopExecutionFirst({ data })).rejects.toThrow('changed')
	state.username = 'jane'
	for (const context of [
		contextFixture({ operator: { handle: 'sam' } }),
		contextFixture({ status: 'revoked' }),
	]) {
		state.page.mockResolvedValue(
			pageFixture({ personalOrg: true, contexts: [context] }),
		)
		await expect(putDesktopExecutionFirst({ data })).rejects.toThrow(
			'not registered',
		)
	}
	expect(state.set).not.toHaveBeenCalled()
})
test('chain conflicts surface instead of overwriting a concurrent edit', async () => {
	state.set.mockResolvedValue({
		ok: false,
		message: 'Your chain changed. Reload and try again.',
	})
	await expect(putDesktopExecutionFirst({ data })).rejects.toThrow(
		'chain changed',
	)
	expect(state.set).toHaveBeenCalledTimes(1)
})

test('desktop setup cannot change team chains or run with the experiment disabled', async () => {
	for (const page of [
		pageFixture({ personalOrg: false }),
		{ enabled: false, orgSlug: 'jane' },
	]) {
		state.page.mockResolvedValue(page)
		await expect(putDesktopExecutionFirst({ data })).rejects.toThrow(
			'personal workspace',
		)
	}
	state.page.mockResolvedValue(
		pageFixture({
			contexts: [
				contextFixture({ ownerOrg: { id: 'org_other', slug: 'other' } }),
			],
		}),
	)
	await expect(putDesktopExecutionFirst({ data })).rejects.toThrow(
		'not registered',
	)
	expect(state.set).not.toHaveBeenCalled()
})
