import { expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ resume: vi.fn(), scope: vi.fn() }))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let schema: { parse(input: unknown): unknown }
		const builder = {
			validator(value: typeof schema) {
				schema = value
				return builder
			},
			inputValidator(value: typeof schema) {
				schema = value
				return builder
			},
			handler(run: (input: { data: unknown }) => unknown) {
				return async (input: { data: unknown }) =>
					run({ data: schema.parse(input.data) })
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
			env: {},
			user: { mcpUser: { userId: 'person-a' } },
			request: new Request('https://kody.test/_serverFn/resume'),
		})
	},
}))
vi.mock('../../src/app/handlers/account-email.ts', () => ({
	resumeAccountOutboundDelivery: state.resume,
}))
import { resumeOutboundEmailDelivery } from './account-mutations.ts'
test('native outbound resume binds the explicit org through authenticated context and rejects owner-id injection', async () => {
	state.resume.mockResolvedValue({ status: 200, data: { ok: true } })
	expect(
		await resumeOutboundEmailDelivery({ data: { orgSlug: 'team-a' } }),
	).toEqual({ ok: true })
	expect(state.scope).toHaveBeenCalledWith({ scope: { orgSlug: 'team-a' } })
	expect(state.resume).toHaveBeenCalledWith(
		expect.objectContaining({ user: { mcpUser: { userId: 'person-a' } } }),
	)
	await expect(
		resumeOutboundEmailDelivery({
			data: { orgSlug: 'team-a', ownerId: 'foreign' } as never,
		}),
	).rejects.toThrow(/Unrecognized key/)
	expect(state.resume).toHaveBeenCalledTimes(1)
})
