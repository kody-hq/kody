import { afterEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	request: new Request('https://kody.test/_serverFn/org', { method: 'POST' }),
	write: vi.fn(async (_input: unknown) => ({
		value: { ok: true },
		status: 200,
	})),
	scope: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let validate: (data: unknown) => unknown
		const builder = {
			validator(
				schema:
					| { parse: (data: unknown) => unknown }
					| ((data: unknown) => unknown),
			) {
				validate =
					typeof schema === 'function' ? schema : (data) => schema.parse(data)
				return builder
			},
			inputValidator(schema: { parse: (data: unknown) => unknown }) {
				return builder.validator(schema)
			},
			handler(run: (input: { data: unknown }) => unknown) {
				return (input: { data: unknown }) => run({ data: validate(input.data) })
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
		return run({ request: state.request, env: {}, user: {} })
	},
}))
vi.mock('../../src/app/handlers/org-members.ts', () => ({
	setOrganizationMemberRole: state.write,
	removeOrganizationMember: state.write,
	inviteOrganizationMember: state.write,
	createOrganizationInviteLink: state.write,
	revokeOrganizationInviteLink: state.write,
}))
vi.mock('../../src/app/handlers/org-settings.ts', () => ({
	updateOrganizationProfile: state.write,
	deleteOrganization: state.write,
	removeOrganizationPhoto: state.write,
	saveOrganizationPhoto: state.write,
	addOrganizationDomain: state.write,
	syncOrganizationDomain: state.write,
	deleteOrganizationDomain: state.write,
}))
import { setOrganizationMemberRole } from './org-mutations.ts'
import {
	addOrganizationDomain,
	deleteOrganization,
	saveOrganizationAvatar,
} from './org-settings-mutations.ts'
afterEach(() => vi.clearAllMocks())
test('named member write validates role and retains explicit org plus original audit request', async () => {
	await setOrganizationMemberRole({
		data: { orgSlug: 'team-a', userId: 'person-a', role: 'billing' },
	})
	expect(state.scope).toHaveBeenCalledWith({ scope: { orgSlug: 'team-a' } })
	expect(state.write).toHaveBeenCalledWith(
		expect.objectContaining({
			request: state.request,
			orgSlug: 'team-a',
			userId: 'person-a',
			role: 'billing',
		}),
	)
	expect(state.write.mock.calls[0]?.[0]).not.toHaveProperty('body')
	expect(() =>
		setOrganizationMemberRole({
			data: {
				orgSlug: 'team-a',
				userId: 'person-a',
				role: 'admin' as 'billing',
			},
		}),
	).toThrow(/Invalid/)
	expect(state.write).toHaveBeenCalledTimes(1)
})
test('domain and deletion fields reach their distinct operations without action routing', async () => {
	await addOrganizationDomain({
		data: {
			orgSlug: 'team-a',
			hostname: 'app.example.com',
			bindingKind: 'app',
			packageId: 'package-a',
		},
	})
	expect(state.write).toHaveBeenLastCalledWith(
		expect.objectContaining({
			request: state.request,
			orgSlug: 'team-a',
			hostname: 'app.example.com',
			bindingKind: 'app',
			packageId: 'package-a',
		}),
	)
	await deleteOrganization({
		data: { orgSlug: 'team-a', confirmation: 'DELETE' },
	})
	expect(state.write).toHaveBeenLastCalledWith(
		expect.objectContaining({
			request: state.request,
			orgSlug: 'team-a',
			confirmation: 'DELETE',
		}),
	)
})
test('multipart avatar preserves file and rejects missing org before acquiring a lease', async () => {
	const form = new FormData()
	form.set('orgSlug', 'team-a')
	const avatar = new File(['png'], 'avatar.png', { type: 'image/png' })
	form.set('avatar', avatar)
	await saveOrganizationAvatar({ data: form })
	expect(state.write).toHaveBeenCalledWith(
		expect.objectContaining({
			request: state.request,
			orgSlug: 'team-a',
			avatar,
		}),
	)
	expect(() => saveOrganizationAvatar({ data: new FormData() })).toThrow(
		/Invalid/,
	)
	expect(state.scope).toHaveBeenCalledTimes(1)
})
