import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	access: vi.fn(),
	write: vi.fn(),
	read: vi.fn(),
	scope: vi.fn(),
	status: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let schema: { parse(input: unknown): unknown }
		const builder = {
			inputValidator(value: typeof schema) {
				schema = value
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
vi.mock('@tanstack/react-start/server', () => ({
	setResponseStatus: state.status,
}))
vi.mock('./mutation-context.ts', () => ({
	withWebsiteMutation: async (
		options: unknown,
		run: (context: unknown) => unknown,
	) => {
		state.scope(options)
		return run({
			env: {},
			user: {},
			request: new Request('https://kody.test/_serverFn/write'),
		})
	},
}))
vi.mock('../../src/app/org-management-access.ts', () => ({
	resolveOrgManagementAccess: state.access,
}))
vi.mock('../../src/app/follows-web.ts', () => ({
	followOrgTarget: state.write,
	resumeOrgFollow: state.write,
	unfollowOrgTarget: state.write,
	loadOrgFollowsData: state.read,
	followOperationStatus: () => 403,
}))
import { followTarget, resumeFollow, unfollowTarget } from './follows.ts'
beforeEach(() => {
	vi.clearAllMocks()
	state.access.mockResolvedValue({ ok: true, org: { id: 'org-id' } })
	state.write.mockResolvedValue({
		ok: true,
		name: '@owner/repo',
		kind: 'repo',
		follow: null,
	})
	state.read.mockRejectedValue(new Error('List unavailable'))
})
test('accepted follow returns operation outcome without rebuilding list, explicitly binding selected workspace', async () => {
	await expect(
		followTarget({
			data: {
				orgSlug: 'team',
				name: '@owner/repo',
				kind: 'repo',
				events: ['pushed'],
			},
		}),
	).resolves.toMatchObject({ ok: true })
	expect(state.scope).toHaveBeenCalledWith({ scope: { orgSlug: 'team' } })
	expect(state.access).toHaveBeenCalledWith(
		expect.objectContaining({ orgSlug: 'team', permission: 'org:read' }),
	)
	expect(state.write).toHaveBeenCalledWith(
		expect.objectContaining({
			org: { id: 'org-id' },
			name: '@owner/repo',
			kind: 'repo',
			events: ['pushed'],
		}),
	)
	expect(state.read).not.toHaveBeenCalled()
})
test('resume and removal remain distinct typed operations scoped by stored follow id', async () => {
	await resumeFollow({ data: { orgSlug: 'team', id: 'follow-id' } })
	await unfollowTarget({ data: { orgSlug: 'team', id: 'follow-id' } })
	expect(state.write).toHaveBeenCalledTimes(2)
	for (const [input] of state.write.mock.calls)
		expect(input).toMatchObject({ org: { id: 'org-id' }, id: 'follow-id' })
})
test('workspace denial prevents mutation and domain denial cannot resolve as success', async () => {
	state.access.mockResolvedValueOnce({
		ok: false,
		status: 403,
		error: 'Denied',
	})
	await expect(
		resumeFollow({ data: { orgSlug: 'team', id: 'id' } }),
	).rejects.toThrow('Denied')
	expect(state.write).not.toHaveBeenCalled()
	state.write.mockResolvedValueOnce({
		ok: false,
		code: 'unauthorized',
		error: 'Target denied',
	})
	await expect(
		unfollowTarget({ data: { orgSlug: 'team', id: 'id' } }),
	).rejects.toThrow('Target denied')
})
