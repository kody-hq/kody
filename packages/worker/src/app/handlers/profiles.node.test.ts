import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	binding: vi.fn(),
	personal: vi.fn(),
	enabled: vi.fn(),
	capability: vi.fn(),
	operation: vi.fn(),
}))

vi.mock('#worker/orgs/repo.ts', () => ({
	loadOrgBindingForSlug: mocks.binding,
}))
vi.mock('#worker/orgs/is-personal-org.ts', () => ({
	isPersonalOrg: mocks.personal,
}))
vi.mock('#worker/profiles/flag.ts', () => ({
	isProfilesEnabledFor: mocks.enabled,
}))
vi.mock('#app/website-capability.ts', () => ({
	websiteCapabilityContext: () => ({
		callerContext: { user: { userId: 'u_jane' } },
	}),
	callCapabilityAsWebsite: (
		_ctx: unknown,
		capability: { name: string },
		args: unknown,
	) => mocks.capability(capability.name, args),
}))
vi.mock('#mcp/capabilities/registry.ts', () => ({
	getStaticRegistry: async () => ({
		capabilityMap: new Proxy(
			{},
			{ get: (_target, name) => ({ name: String(name) }) },
		),
	}),
}))
vi.mock('#worker/open-api/context.ts', () => ({
	createApiInvocationContext: () => ({}),
}))
vi.mock('#worker/open-api/invoke.ts', () => ({
	invokeApiOperation: (input: { operationId: string; params: unknown }) =>
		mocks.operation(input.operationId, input.params),
}))

const {
	createProfileTokenForUser,
	loadProfilesPageData,
	revokeProfileTokenForUser,
	shortenProfileExpiryForUser,
} = await import('./profiles.ts')

const db = {
	prepare: () => ({
		bind: () => ({ all: async () => ({ results: [] }) }),
	}),
}

const base = {
	env: { APP_DB: db } as unknown as Env,
	request: new Request('https://kody.test/@acme/-/profiles'),
	user: {
		mcpUser: { userId: 'u_jane' },
		username: 'jane',
	} as never,
	orgSlug: 'acme',
}

function profileRow(id: string, parent: string | null, status: string) {
	return {
		id,
		name: id,
		parentProfileId: parent,
		actingUserId: 'u_jane',
		depth: parent ? 2 : 1,
		status,
		expiresAt: null,
		effectiveExpiresAt: null,
		revokedAt: null,
		createdAt: '2026-10-31T00:00:00.000Z',
		createdByProfileId: null,
		chain: [{ id, name: id }],
		grants: [],
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.binding.mockResolvedValue({
		org: { id: 'org_acme', slug: 'acme' },
		role: 'owner',
	})
	mocks.personal.mockResolvedValue(false)
	mocks.enabled.mockResolvedValue(true)
	mocks.capability.mockResolvedValue({
		profiles: [
			profileRow('root', null, 'revoked'),
			profileRow('child', 'root', 'parent_inactive'),
		],
	})
	mocks.operation.mockResolvedValue({
		tokens: [
			{
				id: 'tok_1',
				name: 'ci',
				profile_id: 'child',
				org_id: 'org_acme',
				status: 'active',
				scopes: ['org:read'],
				expires_at: '2026-11-01T00:00:00.000Z',
				max_expires_at: '2026-11-01T00:00:00.000Z',
				last_used_at: null,
				created_at: '2026-10-31T00:00:00.000Z',
			},
			{
				id: 'tok_plain',
				name: 'no profile',
				org_id: 'org_acme',
				status: 'active',
			},
			{
				id: 'tok_other',
				profile_id: 'x',
				org_id: 'org_other',
				status: 'active',
			},
		],
	})
})

test('flag off returns the opt-in state without calling capabilities', async () => {
	mocks.enabled.mockResolvedValue(false)
	await expect(
		loadProfilesPageData({ ...base, allMembers: false }),
	).resolves.toEqual({
		enabled: false,
		orgSlug: 'acme',
	})
	expect(mocks.capability).not.toHaveBeenCalled()
})

test('an unknown org is not found', async () => {
	mocks.binding.mockResolvedValue(null)
	await expect(
		loadProfilesPageData({ ...base, allMembers: false }),
	).resolves.toEqual({
		notFound: true,
	})
})

test('Owners asking for every member pass all_members; members cannot', async () => {
	const data = await loadProfilesPageData({ ...base, allMembers: true })
	expect(mocks.capability).toHaveBeenCalledWith('profileList', {
		all_members: true,
	})
	expect(data).toMatchObject({
		enabled: true,
		allMembers: true,
		viewer: { isOwner: true },
	})
	if (!('enabled' in data) || !data.enabled) throw new Error('expected enabled')
	expect(data.profiles.map((profile) => profile.status)).toEqual([
		'revoked',
		'parent_inactive',
	])
	expect(data.tokens.map((token) => token.id)).toEqual(['tok_1'])

	mocks.binding.mockResolvedValue({
		org: { id: 'org_acme', slug: 'acme' },
		role: 'member',
	})
	const member = await loadProfilesPageData({ ...base, allMembers: true })
	expect(mocks.capability).toHaveBeenLastCalledWith('profileList', {})
	expect(member).toMatchObject({
		allMembers: false,
		viewer: { isOwner: false },
	})
})

test('a refused list becomes a page message instead of a crash', async () => {
	mocks.capability.mockRejectedValue(
		Object.assign(new Error('You need profile:manage.'), { code: 'forbidden' }),
	)
	const data = await loadProfilesPageData({ ...base, allMembers: false })
	expect(data).toMatchObject({
		enabled: true,
		profiles: [],
		listError: 'You need profile:manage.',
	})
})

test('a later expiry surfaces profile_expiry_extension', async () => {
	mocks.capability.mockRejectedValue(
		Object.assign(new Error('Expiry can only move earlier.'), {
			code: 'profile_expiry_extension',
		}),
	)
	await expect(
		shortenProfileExpiryForUser({
			...base,
			profileId: 'root',
			expiresAt: '2027-01-01T00:00:00.000Z',
		}),
	).resolves.toMatchObject({ ok: false, error: 'profile_expiry_extension' })
	expect(mocks.capability).toHaveBeenCalledWith('profileUpdate', {
		profile_id: 'root',
		expires_at: '2027-01-01T00:00:00.000Z',
	})
})

test('profile tokens mint through tokenCreate with profile_id and revoke only bound tokens', async () => {
	mocks.operation.mockImplementation(async (operationId: string) =>
		operationId === 'tokenCreate'
			? { id: 'tok_new', token: 'kody_secret_value' }
			: operationId === 'tokenList'
				? {
						tokens: [
							{
								id: 'tok_1',
								profile_id: 'child',
								org_id: 'org_acme',
								status: 'active',
							},
							{ id: 'tok_plain', org_id: 'org_acme', status: 'active' },
						],
					}
				: { id: 'tok_1', status: 'revoked' },
	)
	const created = await createProfileTokenForUser({
		...base,
		profileId: 'child',
		name: 'ci',
		scopes: ['org:read'],
		lifetime: 'short',
	})
	expect(created).toEqual({
		ok: true,
		tokenId: 'tok_new',
		token: 'kody_secret_value',
	})
	expect(mocks.operation).toHaveBeenCalledWith(
		'tokenCreate',
		expect.objectContaining({ profile_id: 'child', scopes: ['org:read'] }),
	)

	await expect(
		revokeProfileTokenForUser({ ...base, tokenId: 'tok_plain' }),
	).resolves.toMatchObject({ ok: false })
	expect(mocks.operation).not.toHaveBeenCalledWith(
		'tokenRevoke',
		expect.anything(),
	)
	await expect(
		revokeProfileTokenForUser({ ...base, tokenId: 'tok_1' }),
	).resolves.toMatchObject({ ok: true })
	expect(mocks.operation).toHaveBeenCalledWith('tokenRevoke', {
		token_id: 'tok_1',
	})
})
