import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	auth: vi.fn(),
	resolution: vi.fn(),
	personal: vi.fn(),
	derive: vi.fn(),
	flags: vi.fn(),
	lease: vi.fn(),
	request: new Request('https://kody.test/@blocked/-/secrets'),
	env: { APP_DB: {}, COOKIE_SECRET: 'request-secret' },
}))
vi.mock('#app/auth-session.ts', () => ({ setAuthSessionSecret: vi.fn() }))
vi.mock('#app/request-auth-cache.ts', () => ({
	loadResolvedRequestAuth: state.auth,
}))
vi.mock('#app/request-feature-flags-cache.ts', () => ({
	prefetchRequestFeatureFlagsForHtmlPage: state.flags,
}))
vi.mock('#app/org-request-binding.ts', () => ({
	loadRequestOrgResolution: state.resolution,
}))
vi.mock('#worker/orgs/repo.ts', () => ({
	loadOrgBindingForPerson: state.personal,
	loadOrgBindingForSlug: vi.fn(),
}))
vi.mock('#worker/request-context/request-context.ts', () => ({
	deriveRequestContext: state.derive,
}))
vi.mock('#worker/account/deletion-state.ts', () => ({
	withAccountWriteLease: state.lease,
}))
vi.mock('../../start/server/request-env.ts', () => ({
	getStartRequestEnv: () => state.env,
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => state.request,
	setResponseHeader: vi.fn(),
}))
import {
	readAuthenticatedAppUser,
	readAuthenticatedAppUserForDeletion,
} from './authenticated-user.ts'
import { withWebsiteMutation } from '../../start/server/mutation-context.ts'

beforeEach(() => {
	vi.clearAllMocks()
	state.auth.mockResolvedValue({
		sessionUserId: 'person_test',
		user: {
			userId: 7,
			mcpUser: { userId: 'person_test' },
			accountDeleting: false,
			accountSuspended: false,
		},
	})
	state.resolution.mockResolvedValue('denied')
	state.personal.mockResolvedValue({ org: { id: 'personal' }, role: 'owner' })
	state.derive.mockImplementation((input) => input)
})

test('denied resource cannot inherit personal binding or execute a website write', async () => {
	const env = state.env as unknown as Env
	const resourceRequest = new Request('https://kody.test/@blocked/-/secrets')
	expect(
		await readAuthenticatedAppUser(
			new Request('https://kody.test/_serverFn/read'),
			env,
			{ resourceRequest, prefetchFeatureFlags: true },
		),
	).toBeNull()
	expect(state.resolution).toHaveBeenCalledWith(
		resourceRequest,
		env,
		'person_test',
	)
	const write = vi.fn()
	await expect(withWebsiteMutation({}, write)).rejects.toThrow('sign in')
	expect(state.personal).toHaveBeenCalledWith(env.APP_DB, 'person_test')
	expect(state.derive).not.toHaveBeenCalled()
	expect(state.flags).not.toHaveBeenCalled()
	expect(state.lease).not.toHaveBeenCalled()
	expect(write).not.toHaveBeenCalled()
})

test('normal personal and granted organization bindings remain distinct', async () => {
	const env = state.env as unknown as Env
	state.resolution.mockResolvedValue('personal')
	expect(await readAuthenticatedAppUser(state.request, env)).not.toBeNull()
	expect(state.personal).toHaveBeenCalledOnce()
	const organization = { org: { id: 'team' }, role: 'member' }
	state.resolution.mockResolvedValue(organization)
	expect(await readAuthenticatedAppUser(state.request, env)).not.toBeNull()
	expect(state.personal).toHaveBeenCalledTimes(2)
	expect(state.derive).toHaveBeenLastCalledWith(
		expect.objectContaining({ orgBinding: organization }),
	)
})

test('deletion retries do not bypass denied organization access', async () => {
	state.auth.mockResolvedValue({
		sessionUserId: 'person_test',
		user: {
			userId: 7,
			mcpUser: { userId: 'person_test' },
			accountDeleting: true,
		},
	})
	expect(
		await readAuthenticatedAppUserForDeletion(
			state.request,
			state.env as unknown as Env,
		),
	).toBeNull()
	expect(state.personal).toHaveBeenCalledWith(state.env.APP_DB, 'person_test')
	expect(state.derive).not.toHaveBeenCalled()
})

test.each(['accountSuspended', 'accountDeleting'])(
	'%s still stops normal authentication before organization access',
	async (flag) => {
		state.auth.mockResolvedValue({
			sessionUserId: 'person_test',
			user: { mcpUser: { userId: 'person_test' }, [flag]: true },
		})
		expect(
			await readAuthenticatedAppUser(
				state.request,
				state.env as unknown as Env,
			),
		).toBeNull()
		expect(state.resolution).not.toHaveBeenCalled()
		expect(state.personal).not.toHaveBeenCalled()
	},
)
