import { expect, test, vi } from 'vitest'
import { type EffectivePermissions } from '#worker/authorization/authorize.ts'
import { queuedProfileRefusal } from './routing.ts'

const state = vi.hoisted(() => ({
	access: null as EffectivePermissions | null,
	member: true,
	requests: [] as Array<{ credential: { profileId?: string | null } }>,
}))

vi.mock('#worker/authorization/authorize.ts', async (original) => ({
	...(await original<object>()),
	computeEffectivePermissions: async (input: {
		request: { credential: { profileId?: string | null } }
	}) => {
		state.requests.push(input.request)
		return state.access
	},
}))

vi.mock('#worker/orgs/repo.ts', async (original) => ({
	...(await original<object>()),
	loadOrgBindingForOrg: async () =>
		state.member
			? {
					org: { id: 'org_acme', slug: 'acme', name: 'Acme', kind: 'team' },
					role: 'member',
				}
			: null,
}))

const lease = {
	profileId: 'prf_bot',
	orgId: 'org_acme',
	requester: { userId: 'user_member', handle: 'member' },
	ecid: 'ec_mac',
	runId: 'run_1',
}
const context = { id: 'ec_mac', org_id: 'org_acme' }
const env = {} as Env

function accessWith(input: {
	inactive?: boolean
	permissions: Array<string>
}): EffectivePermissions {
	return {
		orgId: 'org_acme',
		permissions: new Set(['execution_context:execute']),
		isOwner: false,
		resourcePermissions: new Map(),
		credentialScopes: null,
		profileGrants: null,
		profileChain: {
			inactive: input.inactive
				? { id: 'prf_root', name: 'root', self: false, reason: 'expired' }
				: null,
			layers: [
				{
					id: 'prf_bot',
					name: 'bot',
					self: true,
					orgPermissions: new Set(),
					resourcePermissions: new Map([
						['execution_context:ec_mac', new Set(input.permissions)],
					]),
				},
			],
		},
	} as unknown as EffectivePermissions
}

test('a queued run with no profile is not rechecked here', async () => {
	state.requests = []
	expect(
		await queuedProfileRefusal({
			env,
			lease: { ...lease, profileId: null },
			context,
		}),
	).toBeNull()
	expect(state.requests).toHaveLength(0)
})

test('a queued profile run dispatches only while its chain is active and granted', async () => {
	state.member = true
	state.requests = []
	state.access = accessWith({ permissions: ['execution_context:execute'] })
	expect(await queuedProfileRefusal({ env, lease, context })).toBeNull()
	expect(state.requests[0]?.credential.profileId).toBe('prf_bot')

	state.access = accessWith({ permissions: [] })
	expect(await queuedProfileRefusal({ env, lease, context })).toMatch(
		/execution_context:execute/,
	)

	state.access = accessWith({
		inactive: true,
		permissions: ['execution_context:execute'],
	})
	expect(await queuedProfileRefusal({ env, lease, context })).toMatch(
		/revoked, expired/,
	)

	state.member = false
	expect(await queuedProfileRefusal({ env, lease, context })).toMatch(
		/no longer in the org/,
	)
})
