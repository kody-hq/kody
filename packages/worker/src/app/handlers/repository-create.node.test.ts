import { beforeEach, expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type * as AuthorizeModule from '#worker/authorization/authorize.ts'
import { EntitlementLimitError } from '#worker/entitlements/errors.ts'

const state = vi.hoisted(() => ({
	organizations: [] as Array<{
		slug: string
		displayName: string | null
		role: 'owner' | 'member' | 'billing' | null
		personal: boolean
		avatarKey: string | null
	}>,
	creatable: new Set<string>(),
	personalOrgIds: new Set<string>(['person-1']),
	repoCreate: vi.fn(),
}))

vi.mock('#worker/orgs/repo.ts', () => ({
	listOrganizationsForPerson: async () => state.organizations,
	loadOrgBindingForSlug: async (
		_db: unknown,
		_personId: string,
		slug: string,
	) => {
		const organization = state.organizations.find((row) => row.slug === slug)
		if (!organization) return null
		return {
			org: {
				id: organization.personal ? 'person-1' : `org-${organization.slug}`,
				slug: organization.slug,
			},
			role: organization.role,
		}
	},
}))

vi.mock('#worker/orgs/is-personal-org.ts', () => ({
	isPersonalOrg: async (_db: unknown, orgId: string) =>
		state.personalOrgIds.has(orgId),
}))

vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuthorizeModule>()
	return {
		...actual,
		computeEffectivePermissions: async (input: {
			request: { org: { slug: string | null } }
		}) => ({ slug: input.request.org.slug }),
		checkPermission: (access: { slug: string }, permission: string) => ({
			allowed:
				permission === 'package:create' && state.creatable.has(access.slug),
		}),
	}
})

vi.mock('#mcp/capabilities/repo/repo-create.ts', () => ({
	repoCreateCapability: {
		handler: (...args: Array<unknown>) => state.repoCreate(...args),
	},
}))

const { createWebsiteRepository, loadRepositoryCreateOptions } =
	await import('./repository-create.ts')

const user = {
	mcpUser: { userId: 'person-1', email: 'jane@example.com' },
} as unknown as Parameters<typeof createWebsiteRepository>[0]['user']

function context() {
	return {
		env: { APP_DB: {} } as unknown as Env,
		request: new Request('https://kody.test/_serverFn/createRepository', {
			method: 'POST',
		}),
		user,
	}
}

function authorizationError() {
	return new AuthorizationError({
		code: 'missing_permission',
		permission: 'package:create',
		orgId: 'org-acme' as OwnerId,
		resource: null,
		message: 'You need package:create in @acme.',
	})
}

beforeEach(() => {
	state.organizations = [
		{
			slug: 'zeta',
			displayName: 'Zeta',
			role: 'owner',
			personal: false,
			avatarKey: null,
		},
		{
			slug: 'jane',
			displayName: null,
			role: 'owner',
			personal: true,
			avatarKey: null,
		},
		{
			slug: 'acme',
			displayName: 'Acme',
			role: 'billing',
			personal: false,
			avatarKey: null,
		},
	]
	state.creatable = new Set(['jane', 'zeta'])
	state.repoCreate.mockReset()
	state.repoCreate.mockImplementation(async (args: { name: string }) => ({
		repo_id: 'repo-1',
		name: args.name.trim().toLowerCase(),
		source_id: 'src-1',
		repo_git_id: 'git-1',
	}))
})

test('owner options list personal first and only orgs that allow package:create', async () => {
	const options = await loadRepositoryCreateOptions(context())
	expect(options).toEqual({
		ok: true,
		owners: [
			{ slug: 'jane', displayName: null, personal: true },
			{ slug: 'zeta', displayName: 'Zeta', personal: false },
		],
	})
	expect(JSON.stringify(options)).not.toContain('org-')
})

test('invalid names are refused before repoCreate runs', async () => {
	for (const name of [
		'',
		'Has Spaces',
		'-leading',
		'trailing-',
		'a'.repeat(65),
	]) {
		const result = await createWebsiteRepository({
			...context(),
			ownerSlug: 'jane',
			name,
		})
		expect(result).toMatchObject({ ok: false, field: 'name' })
	}
	expect(state.repoCreate).not.toHaveBeenCalled()
})

test('creates through repoCreate bound to the chosen owner and returns the agent prompt', async () => {
	const result = await createWebsiteRepository({
		...context(),
		ownerSlug: 'zeta',
		name: 'Launch-Site',
	})
	expect(state.repoCreate).toHaveBeenCalledTimes(1)
	const [args, ctx] = state.repoCreate.mock.calls[0] as [
		{ name: string },
		{ callerContext: { request: { org: { id: string; slug: string } } } },
	]
	expect(args).toEqual({ name: 'Launch-Site' })
	expect(ctx.callerContext.request.org).toEqual({
		id: 'org-zeta',
		slug: 'zeta',
	})
	expect(result).toMatchObject({
		ok: true,
		owner: 'zeta',
		name: 'launch-site',
		personal: false,
		repositoryHref: '/@zeta/launch-site',
		cloneUrl: 'https://kody.test/@zeta/launch-site.git',
	})
	if (!result.ok) throw new Error('expected success')
	expect(result.prompt).toContain('@zeta/launch-site')
	expect(result.prompt).toContain(
		'git clone https://kody.test/@zeta/launch-site.git',
	)
	expect(result.prompt).toContain('login --org zeta')
	expect(result.prompt).toContain(
		'package publish @zeta/launch-site --org zeta',
	)
	expect(result.prompt).toContain('https://kody.test/mcp?org=zeta')
	expect(result.prompt).not.toContain('repo-1')
	expect(result.prompt).not.toContain('git-1')
})

test('personal repos skip the --org flag', async () => {
	const result = await createWebsiteRepository({
		...context(),
		ownerSlug: 'jane',
		name: 'notes',
	})
	if (!result.ok) throw new Error('expected success')
	expect(result.personal).toBe(true)
	expect(result.prompt).not.toContain('--org')
	expect(result.prompt).not.toContain('?org=')
	expect(result.prompt).toContain('package publish @jane/notes`')
})

test('owners the viewer is not in, or lacks package:create for, are refused', async () => {
	const missing = await createWebsiteRepository({
		...context(),
		ownerSlug: 'stranger',
		name: 'notes',
	})
	expect(missing).toEqual({
		ok: false,
		error: "You can't create repositories in that account.",
		field: 'owner',
	})
	expect(state.repoCreate).not.toHaveBeenCalled()

	state.repoCreate.mockRejectedValueOnce(authorizationError())
	const denied = await createWebsiteRepository({
		...context(),
		ownerSlug: 'acme',
		name: 'notes',
	})
	expect(denied).toEqual({
		ok: false,
		error:
			"You can't create repositories in that account. You need package:create in @acme.",
		field: 'owner',
	})
})

test('name conflicts surface on the name field', async () => {
	state.repoCreate.mockRejectedValueOnce(
		new McpCallerError('A plain repo named "notes" already exists in @jane.'),
	)
	const result = await createWebsiteRepository({
		...context(),
		ownerSlug: 'jane',
		name: 'notes',
	})
	expect(result).toEqual({
		ok: false,
		error: 'A plain repo named "notes" already exists in @jane.',
		field: 'name',
	})
})

test('plan limits surface as a form error', async () => {
	state.repoCreate.mockRejectedValueOnce(
		new EntitlementLimitError({
			resource: 'repos',
			plan: 'free',
			limit: 3,
			current: 3,
			upgradeHint: 'Upgrade to create more.',
		}),
	)
	const result = await createWebsiteRepository({
		...context(),
		ownerSlug: 'jane',
		name: 'notes',
	})
	expect(result).toMatchObject({ ok: false, field: null })
	if (result.ok) throw new Error('expected refusal')
	expect(result.error).toContain('Plan limit reached')
})

test('unexpected failures are not swallowed', async () => {
	state.repoCreate.mockRejectedValueOnce(new Error('D1 down'))
	await expect(
		createWebsiteRepository({ ...context(), ownerSlug: 'jane', name: 'notes' }),
	).rejects.toThrow('D1 down')
})
