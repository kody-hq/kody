import { afterEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	request: new Request('https://kody.test/_serverFn/admin', {
		method: 'POST',
		headers: { 'cf-connecting-ip': '192.0.2.1' },
	}),
	write: vi.fn(async (_input: unknown) => ({ ok: true })),
	lease: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let schema: { parse: (data: unknown) => unknown }
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
				return (input: { data: unknown }) =>
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
		state.lease(options)
		return run({ env: {}, request: state.request, user: {} })
	},
}))
vi.mock('../../src/admin/users-operations.ts', () => ({
	assignAdminUserRole: state.write,
	removeAdminUserRole: state.write,
	setAdminUserSuspension: state.write,
}))
vi.mock('../../src/admin/system-email-operations.ts', () => ({
	deleteAdminSystemEmail: state.write,
}))
import {
	assignAdminUserRole,
	suspendAdminUser,
	unsuspendAdminUser,
	deleteAdminSystemEmail,
} from './admin-mutations.ts'
afterEach(() => vi.clearAllMocks())
test('named admin role write preserves audit request without coupling writes to list filters', async () => {
	await assignAdminUserRole({
		data: {
			stableUserId: 'person-a',
			role: 'admin',
		},
	})
	expect(state.lease).toHaveBeenCalledWith({})
	const input = state.write.mock.calls[0]?.[0]
	expect(input).toMatchObject({
		request: state.request,
		stableUserId: 'person-a',
		role: 'admin',
	})
	expect(input).not.toHaveProperty('body')
	expect(input).not.toHaveProperty('url')
	expect(input).not.toHaveProperty('search')
	expect(() =>
		assignAdminUserRole({
			data: { stableUserId: 'person-a', role: 'unknown' as 'admin' },
		}),
	).toThrow(/Invalid/)
	expect(state.lease).toHaveBeenCalledTimes(1)
})
test('suspend and resume are distinct operations with fixed suspension values', async () => {
	await suspendAdminUser({ data: { stableUserId: 'person-a' } })
	expect(state.write).toHaveBeenLastCalledWith(
		expect.objectContaining({
			request: state.request,
			stableUserId: 'person-a',
			suspended: true,
		}),
	)
	await unsuspendAdminUser({ data: { stableUserId: 'person-a' } })
	expect(state.write).toHaveBeenLastCalledWith(
		expect.objectContaining({
			request: state.request,
			stableUserId: 'person-a',
			suspended: false,
		}),
	)
})
test('system email deletion submits its message id without page URL inputs', async () => {
	await deleteAdminSystemEmail({
		data: { messageId: 'message-a' },
	})
	expect(state.write).toHaveBeenCalledWith(
		expect.objectContaining({
			request: state.request,
			messageId: 'message-a',
		}),
	)
	expect(state.write.mock.lastCall?.[0]).not.toHaveProperty('url')
	expect(state.write.mock.lastCall?.[0]).not.toHaveProperty('search')
})
