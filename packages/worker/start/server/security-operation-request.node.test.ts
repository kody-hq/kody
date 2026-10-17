import { afterEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	request: new Request('https://kody.test/_serverFn/security', {
		method: 'POST',
	}),
	rename: vi.fn(async (_input: unknown) => ({ ok: true, passkeys: [] })),
	remove: vi.fn(async (_input: unknown) => ({ ok: true, passkeys: [] })),
	confirm: vi.fn(async (_input: unknown) => ({ ok: true, enabled: true })),
	disable: vi.fn(async (_input: unknown) => ({ ok: true, enabled: false })),
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
		return run({ request: state.request, env: {}, user: { userId: 7 } })
	},
}))
vi.mock('../../src/app/handlers/account-passkeys.ts', () => ({
	renameAccountPasskey: state.rename,
	deleteAccountPasskey: state.remove,
}))
vi.mock('../../src/app/handlers/account-two-factor.ts', () => ({
	confirmAccountTwoFactorSetup: state.confirm,
	disableAccountTwoFactor: state.disable,
}))
import {
	renamePasskey,
	deletePasskey,
	confirmTwoFactorSetup,
	disableTwoFactor,
} from './security-mutations.ts'
afterEach(() => vi.clearAllMocks())
test('passkey operations retain current user, original request and distinct operation ownership', async () => {
	await renamePasskey({ data: { passkeyId: 'key-a', name: 'Phone' } })
	expect(state.rename).toHaveBeenCalledWith({
		request: state.request,
		env: {},
		user: { userId: 7 },
		passkeyId: 'key-a',
		name: 'Phone',
	})
	expect(state.remove).not.toHaveBeenCalled()
	await deletePasskey({ data: { passkeyId: 'key-a' } })
	expect(state.remove).toHaveBeenCalledWith({
		request: state.request,
		env: {},
		user: { userId: 7 },
		passkeyId: 'key-a',
	})
	expect(state.lease).toHaveBeenCalledTimes(2)
})
test('two-factor confirmation and disable require typed codes before taking a lease', async () => {
	expect(() =>
		confirmTwoFactorSetup({ data: { code: 123456 as unknown as string } }),
	).toThrow(/Invalid/)
	expect(state.lease).not.toHaveBeenCalled()
	await confirmTwoFactorSetup({ data: { code: '123456' } })
	expect(state.confirm).toHaveBeenCalledWith(
		expect.objectContaining({
			request: state.request,
			user: { userId: 7 },
			code: '123456',
		}),
	)
	await disableTwoFactor({ data: { code: '654321' } })
	expect(state.disable).toHaveBeenCalledWith(
		expect.objectContaining({
			request: state.request,
			user: { userId: 7 },
			code: '654321',
		}),
	)
})
