import { expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ save: vi.fn(), scope: vi.fn() }))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let schema: { parse(input: unknown): unknown }
		const builder = {
			validator(next: typeof schema) {
				schema = next
				return builder
			},
			inputValidator(next: typeof schema) {
				schema = next
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
			request: new Request('https://kody.test/_serverFn/save'),
			env: {},
			user: { id: 'actor' },
		})
	},
}))
vi.mock('../../src/app/handlers/account-secrets.ts', () => ({
	saveAccountSecret: state.save,
}))
import { saveSecret } from './account-mutations.ts'
const data = {
	orgSlug: 'team',
	fields: {
		currentId: 'user::::Henry',
		name: 'henry',
		scope: 'user' as const,
		packageId: null,
		description: '',
		expiresAt: null,
		value: 'replacement',
		allowedHosts: [],
		allowedPackages: [],
	},
}
test('native secret save carries only committed rename recovery and preserves normal errors', async () => {
	const recovery = {
		ok: false as const,
		error: 'value write failed',
		selectedSecret: { id: 'user::::henry', name: 'henry' },
	}
	state.save.mockResolvedValueOnce({ status: 400, data: recovery })
	expect(await saveSecret({ data })).toEqual(recovery)
	expect(state.scope).toHaveBeenLastCalledWith({ scope: { orgSlug: 'team' } })
	expect(state.save).toHaveBeenLastCalledWith(
		expect.objectContaining({ fields: data.fields, user: { id: 'actor' } }),
	)
	state.save.mockResolvedValueOnce({
		status: 400,
		data: { ok: false, error: 'Rejected before rename' },
	})
	await expect(saveSecret({ data })).rejects.toThrow('Rejected before rename')
	state.save.mockResolvedValueOnce({
		status: 404,
		data: { ok: false, error: 'Not found' },
	})
	await expect(saveSecret({ data })).rejects.toThrow('Not found')
})
