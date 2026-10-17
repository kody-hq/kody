import { expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ write: vi.fn(), scope: vi.fn() }))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let schema: { parse(data: unknown): unknown }
		const builder = {
			validator(value: typeof schema) {
				schema = value
				return builder
			},
			handler(run: (input: { data: unknown }) => unknown) {
				return (input: { data: unknown }) =>
					run({ data: schema ? schema.parse(input.data) : input.data })
			},
		}
		return builder
	},
}))
vi.mock('./mutation-context.ts', () => ({
	withWebsiteMutation: async (
		options: unknown,
		run: (context: unknown) => unknown,
	) => {
		state.scope(options)
		return run({
			request: new Request('https://kody.test/_serverFn/restore'),
			env: {},
			user: { mcpUser: { userId: 'signed-in-owner' } },
		})
	},
}))
vi.mock('../../src/app/handlers/account-organizations.ts', () => ({
	restoreWebsiteOrganization: state.write,
}))
import { restoreOrganization } from './org-organizations.ts'
test('native restore accepts only a slug and forwards authenticated context through the website write lease', async () => {
	state.write.mockResolvedValue({ slug: 'team' })
	expect(await restoreOrganization({ data: { orgSlug: 'team' } })).toEqual({
		slug: 'team',
	})
	expect(state.scope).toHaveBeenCalledWith({})
	expect(state.write).toHaveBeenCalledWith(
		expect.objectContaining({
			orgSlug: 'team',
			user: { mcpUser: { userId: 'signed-in-owner' } },
		}),
	)
	expect(() =>
		restoreOrganization({
			data: { orgSlug: 'team', orgId: 'foreign-org' } as never,
		}),
	).toThrow(/Unrecognized key/)
	expect(state.write).toHaveBeenCalledTimes(1)
})
