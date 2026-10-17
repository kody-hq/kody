import { beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	authorize: vi.fn(),
	acceptInvite: vi.fn(),
	declineInvite: vi.fn(),
	acceptLink: vi.fn(),
	declineLink: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let validator: { parse: (data: unknown) => unknown }
		const builder = {
			validator(next: typeof validator) {
				validator = next
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
		_options: unknown,
		run: (context: unknown) => unknown,
	) => {
		await mocks.authorize()
		return run({
			user: { id: 'person' },
			env: {},
			request: new Request('https://kody.test/_server'),
		})
	},
}))
vi.mock('../../src/app/handlers/account-invites.ts', () => ({
	acceptWebsiteInvite: mocks.acceptInvite,
	declineWebsiteInvite: mocks.declineInvite,
}))
vi.mock('../../src/app/handlers/org-invite-join.ts', () => ({
	acceptWebsiteInviteLink: mocks.acceptLink,
	declineWebsiteInviteLink: mocks.declineLink,
}))
import {
	acceptPendingInvite,
	declinePendingInvite,
	acceptPendingInviteLink,
	declinePendingInviteLink,
} from './account-invites.ts'
beforeEach(() => {
	vi.resetAllMocks()
	for (const operation of [
		mocks.acceptInvite,
		mocks.declineInvite,
		mocks.acceptLink,
		mocks.declineLink,
	])
		operation.mockResolvedValue({ status: 200, data: { ok: true } })
})
test('pending invite actions require authenticated website mutation context', async () => {
	mocks.authorize.mockRejectedValue(new Error('Unauthorized'))
	await expect(
		acceptPendingInvite({
			data: { id: 'invite-1' },
		}),
	).rejects.toThrow('Unauthorized')
	expect(mocks.acceptInvite).not.toHaveBeenCalled()
})
test.each(['invite', 'link'] as const)(
	'validates and dispatches %s actions without trusting a caller identity',
	async (source) => {
		await expect(
			(source === 'link' ? acceptPendingInviteLink : acceptPendingInvite)({
				data: { id: '' },
			}),
		).rejects.toThrow(/Too small/)
		expect(mocks.authorize).not.toHaveBeenCalled()
		for (const action of ['accept', 'decline'] as const) {
			await (
				source === 'link'
					? action === 'accept'
						? acceptPendingInviteLink
						: declinePendingInviteLink
					: action === 'accept'
						? acceptPendingInvite
						: declinePendingInvite
			)({ data: { id: 'target' } })
			const operation =
				source === 'link'
					? action === 'accept'
						? mocks.acceptLink
						: mocks.declineLink
					: action === 'accept'
						? mocks.acceptInvite
						: mocks.declineInvite
			expect(operation).toHaveBeenCalledWith(
				expect.objectContaining({
					user: { id: 'person' },
					[source === 'link' ? 'linkId' : 'inviteId']: 'target',
				}),
			)
		}
	},
)
test('domain rejection propagates instead of appearing successful', async () => {
	mocks.acceptLink.mockResolvedValue({
		status: 400,
		data: { ok: false, error: 'This invite link has expired.' },
	})
	await expect(
		acceptPendingInviteLink({
			data: { id: 'expired' },
		}),
	).rejects.toThrow('This invite link has expired.')
})

test('accept preserves the destination returned by the authorized operation', async () => {
	mocks.acceptInvite.mockResolvedValue({
		status: 200,
		data: { ok: true, redirectTo: '/@team/package' },
	})
	expect(
		await acceptPendingInvite({
			data: { id: 'offer' },
		}),
	).toEqual({ ok: true, redirectTo: '/@team/package' })
})
