import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	authenticated: true,
	convert: vi.fn(),
	scope: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let validator: { parse(input: unknown): unknown }
		const builder = {
			validator(schema: typeof validator) {
				validator = schema
				return builder
			},
			handler(run: (input: { data: unknown }) => unknown) {
				return async (input: { data: unknown }) =>
					run({ data: validator.parse(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('./mutation-context.ts', () => ({
	withWebsiteMutation: async (
		options: unknown,
		write: (context: unknown) => unknown,
	) => {
		if (!state.authenticated) throw new Error('Please sign in again.')
		state.scope(options)
		return write({
			env: { APP_DB: {} },
			user: { username: 'old-handle', mcpUser: { userId: 'signed-in-person' } },
		})
	},
}))
vi.mock('../../src/orgs/convert-personal-org.ts', () => ({
	convertPersonalOrg: state.convert,
	ConvertPersonalOrgError: class extends Error {
		code = 'handle_taken'
	},
}))
import { convertPersonalOrganization } from './convert-personal-org.ts'
beforeEach(() => {
	state.authenticated = true
	state.convert.mockReset()
	state.scope.mockClear()
})
const data = { newHandle: 'new-handle', confirmation: 'convert @old-handle' }
test('native conversion authenticates and checks current-handle confirmation before domain writes', async () => {
	state.authenticated = false
	await expect(convertPersonalOrganization({ data })).rejects.toThrow(
		'Please sign in again.',
	)
	state.authenticated = true
	await expect(
		convertPersonalOrganization({
			data: { ...data, confirmation: 'convert @different' },
		}),
	).rejects.toThrow('Type convert @old-handle')
	await expect(
		convertPersonalOrganization({
			data: { ...data, personId: 'foreign' } as never,
		}),
	).rejects.toThrow(/Unrecognized key/)
	expect(state.convert).not.toHaveBeenCalled()
})
test('native conversion derives authority from the session and returns only the committed identity result', async () => {
	state.convert.mockResolvedValue({
		convertedSlug: 'old-handle',
		newUsername: 'new-handle',
		internalOrgId: 'private',
		followUpFailures: ['email_inbox'],
	})
	expect(await convertPersonalOrganization({ data })).toEqual({
		ok: true,
		convertedSlug: 'old-handle',
		newUsername: 'new-handle',
		followUpFailures: ['email_inbox'],
	})
	expect(state.scope).toHaveBeenCalledWith({})
	expect(state.convert).toHaveBeenCalledWith({
		env: { APP_DB: {} },
		personId: 'signed-in-person',
		newHandle: 'new-handle',
	})
})
test('safe domain errors preserve code and message for the native conversion form', async () => {
	const { ConvertPersonalOrgError } =
		await import('../../src/orgs/convert-personal-org.ts')
	state.convert.mockRejectedValue(
		new ConvertPersonalOrgError('That handle is taken.', 'handle_taken'),
	)
	expect(await convertPersonalOrganization({ data })).toEqual({
		ok: false,
		error: 'That handle is taken.',
		code: 'handle_taken',
	})
})
