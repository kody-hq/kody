import { orgPermissions } from '@kody-internal/shared/org-permissions.ts'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import {
	deriveRequestContext,
	inheritRequest,
	type RequestSource,
} from '#worker/request-context/request-context.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import {
	assertLivePerson,
	nonInteractiveTriggerOf,
	authorize,
	authorizeSurface,
	isLivePersonRequest,
	LivePersonRequiredError,
	AuthorizationError,
	authorizePackageCreate,
	canSeeResource,
	checkOrgWide,
	checkPermission,
	computeEffectivePermissions,
	getRequestPermissions,
	packageResource as storedPackageResource,
	runWithRequestPermissions,
	type EffectivePermissions,
	type OrgResource,
} from './authorize.ts'

const mocks = vi.hoisted(() => ({
	resolveConnectionProfileGrants: vi.fn(),
	compileAccessForRequest: vi.fn(),
}))

vi.mock('#worker/connection-profiles/repo.ts', () => ({
	resolveConnectionProfileGrants: (...args: Array<unknown>) =>
		mocks.resolveConnectionProfileGrants(...args),
}))

vi.mock('./access-compile.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./access-compile.ts')>()
	return {
		...actual,
		compileAccessForRequest: (...args: Array<unknown>) =>
			mocks.compileAccessForRequest(...args),
	}
})

const env = { APP_DB: {} } as Env

function access(
	overrides: Partial<EffectivePermissions> = {},
): EffectivePermissions {
	return {
		orgId: ownerIdFromStored('org-1'),
		permissions: new Set(orgPermissions),
		isOwner: true,
		resourcePermissions: new Map(),
		credentialScopes: null,
		profileGrants: null,
		...overrides,
	}
}

function packageResource(overrides: Partial<OrgResource> = {}): OrgResource {
	return {
		type: 'package',
		id: 'pkg-1',
		orgId: ownerIdFromStored('org-1'),
		label: '@kent/invoices',
		...overrides,
	}
}

function denial(decision: ReturnType<typeof checkPermission>) {
	if (decision.allowed) throw new Error('Expected a denial.')
	return decision.error
}

function stubCompile(request: RequestContext) {
	const role = request.membership?.role ?? null
	const isOwner = !request.actor || role === 'owner'
	mocks.compileAccessForRequest.mockResolvedValue({
		orgId: request.org.id,
		epoch: 0,
		isOwner,
		orgPermissions: isOwner
			? new Set(orgPermissions)
			: role === 'member'
				? new Set(['org:read', 'member:read', 'team:read', 'search:read'])
				: role === 'billing'
					? new Set([
							'org:read',
							'member:read',
							'search:read',
							'billing:read',
							'billing:write',
						])
					: new Set(['search:read']),
		resourcePermissions: new Map(),
	})
}

test('every person owns their implicit org and holds every org permission in it', async () => {
	const request = sessionRequestContext('user-1')
	stubCompile(request)
	const effective = await computeEffectivePermissions({ env, request })

	expect(effective.orgId).toBe(personalOrgId(personIdFromStored('user-1')))
	expect(effective.isOwner).toBe(true)
	expect(effective.credentialScopes).toBeNull()
	expect(effective.profileGrants).toBeNull()
	await expect(
		authorize({ env, request }, 'package:write', {
			type: 'package',
			id: 'pkg-1',
			orgId: request.org.id,
		}),
	).resolves.toBeUndefined()
})

test('Automation acts for its org with no actor', async () => {
	const request = deriveRequestContext({
		user: { userId: personIdFromStored('user-1') },
		source: { kind: 'schedule', jobId: 'job-1' },
	})
	stubCompile(request)
	expect(request.actor).toBeNull()
	await expect(
		authorize({ env, request }, 'job:execute'),
	).resolves.toBeUndefined()
})

test('a member holds only the role basics', async () => {
	const owner = sessionRequestContext('user-1')
	const member: RequestContext = { ...owner, membership: { role: 'member' } }
	stubCompile(member)
	const error = await authorize(
		{ env, request: member },
		'package:write',
	).catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(AuthorizationError)
	expect(error).toMatchObject({
		code: 'missing_permission',
		permission: 'package:write',
		message: 'Missing package:write. An org Owner can grant it.',
	})
})

test('a resource grant lets a member act on that resource only', () => {
	const memberAccess = access({
		isOwner: false,
		permissions: new Set([
			'org:read',
			'member:read',
			'team:read',
			'search:read',
		]),
		resourcePermissions: new Map([
			['package:pkg-1', new Set(['package:read', 'package:execute'])],
		]),
	})
	expect(
		checkPermission(memberAccess, 'package:execute', packageResource()).allowed,
	).toBe(true)
	// Without a resource, surface checks pass when the permission is held
	// somewhere in the org (Teams spec §6.3).
	expect(checkPermission(memberAccess, 'package:execute').allowed).toBe(true)
	expect(
		checkPermission(
			memberAccess,
			'package:execute',
			packageResource({ id: 'pkg-2', label: undefined }),
		).allowed,
	).toBe(false)
})

test('a credential denial names the credential by family and name, not by id', () => {
	const memberAccess = access({ isOwner: false, permissions: new Set() })
	const credential = (label: string): OrgResource => ({
		type: 'credential',
		id: 'cred-1',
		orgId: ownerIdFromStored('org-1'),
		label,
	})
	expect(
		denial(checkPermission(memberAccess, 'secret:use', credential('apiKey')))
			.message,
	).toBe('Missing secret:use on secret apiKey. An org Owner can grant it.')
	expect(
		denial(
			checkPermission(memberAccess, 'integration:use', credential('google')),
		).message,
	).toBe(
		'Missing integration:use on integration google. An org Owner can grant it.',
	)
})

test('a resource in another org is denied before permissions are read', () => {
	const error = denial(
		checkPermission(
			access(),
			'package:read',
			packageResource({ orgId: ownerIdFromStored('org-2') }),
		),
	)
	expect(error.code).toBe('wrong_org')
	expect(error.message).toBe('package @kent/invoices belongs to another org.')
})

test('credential scopes narrow what the role grants and name the exact scopes to mint', () => {
	const scoped = access({
		credentialScopes: new Set(['package:read', 'org:execute']),
	})
	expect(checkPermission(scoped, 'package:read').allowed).toBe(true)
	const error = denial(
		checkPermission(scoped, 'package:write', packageResource()),
	)
	expect(error.code).toBe('credential_scope')
	expect(error.mintScopes).toEqual([
		'org:execute',
		'package:read',
		'package:write',
	])
})

test('org-wide denials only suggest a token when the role already holds the permission org-wide', () => {
	const scopedOwner = access({ credentialScopes: new Set(['org:execute']) })
	const ownerDenial = denial(checkOrgWide(scopedOwner, 'job:read'))
	expect(ownerDenial.code).toBe('credential_scope')
	expect(ownerDenial.mintScopes).toEqual(['job:read', 'org:execute'])
	expect(ownerDenial.message).toContain('--scopes job:read,org:execute')

	const collaborator = access({
		isOwner: false,
		permissions: new Set(),
		resourcePermissions: new Map([['job:job-a', new Set(['job:read'])]]),
		credentialScopes: new Set(['org:execute']),
	})
	const collaboratorDenial = denial(checkOrgWide(collaborator, 'job:read'))
	expect(collaboratorDenial.code).toBe('missing_permission')
	expect(collaboratorDenial.mintScopes).toBeNull()
})

test('role denials do not suggest minting a token', () => {
	const member = access({
		isOwner: false,
		permissions: new Set(['package:read']),
		credentialScopes: new Set(['package:read', 'package:write']),
	})
	const error = denial(
		checkPermission(member, 'package:write', packageResource()),
	)
	expect(error.code).toBe('missing_permission')
	expect(error.mintScopes).toBeNull()
})

test('a connection profile narrows the package resources it lists', () => {
	const profiled = access({
		profileGrants: [
			{ resourceType: 'package', resourceId: 'pkg-1', actions: ['read'] },
		],
	})
	expect(
		checkPermission(profiled, 'package:read', packageResource()).allowed,
	).toBe(true)
	const executeDenied = denial(
		checkPermission(
			profiled,
			'package:execute',
			packageResource({ label: undefined }),
		),
	)
	expect(executeDenied.code).toBe('connection_profile')
	expect(
		checkPermission(
			profiled,
			'package:read',
			packageResource({ id: 'pkg-2', label: undefined }),
		).allowed,
	).toBe(false)
	const writeDenied = denial(
		checkPermission(profiled, 'package:write', packageResource()),
	)
	expect(writeDenied.code).toBe('connection_profile')
	const writeGranted = access({
		profileGrants: [
			{
				resourceType: 'package',
				resourceId: 'pkg-1',
				actions: ['read', 'write'],
			},
		],
	})
	expect(
		checkPermission(writeGranted, 'package:write', packageResource()).allowed,
	).toBe(true)
	for (const permission of ['package:delete', 'package:publish'] as const) {
		const denied = denial(
			checkPermission(profiled, permission, packageResource()),
		)
		expect(denied.code).toBe('connection_profile')
		expect(
			checkPermission(writeGranted, permission, packageResource()).allowed,
		).toBe(true)
	}
	// Org-level package:create stays open so plain repo create is unchanged.
	expect(checkPermission(profiled, 'package:create').allowed).toBe(true)
	// Profiles list packages only, so other resources and org-level checks
	// are left to the role and credential.
	expect(checkPermission(profiled, 'package:read').allowed).toBe(true)
	expect(
		checkPermission(profiled, 'secret:use', {
			type: 'credential',
			id: 'token',
			orgId: ownerIdFromStored('org-1'),
		}).allowed,
	).toBe(true)
})

test('a bound profile cannot create a saved package and an unbound caller can', async () => {
	const bound = deriveRequestContext({
		user: { userId: personIdFromStored('user-1') },
		source: { kind: 'mcp-oauth' },
		profileName: 'work',
	})
	stubCompile(bound)
	mocks.resolveConnectionProfileGrants.mockResolvedValueOnce([
		{
			resourceType: 'package',
			resourceId: 'pkg-1',
			actions: ['read', 'write'],
		},
	])
	const error = await authorizePackageCreate({
		env,
		request: bound,
	}).catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(AuthorizationError)
	expect(error).toMatchObject({
		code: 'connection_profile',
		permission: 'package:create',
	})

	const emptyGrants = deriveRequestContext({
		user: { userId: personIdFromStored('user-1') },
		source: { kind: 'mcp-oauth' },
		profileName: 'empty',
	})
	stubCompile(emptyGrants)
	mocks.resolveConnectionProfileGrants.mockResolvedValueOnce([])
	await expect(
		authorizePackageCreate({ env, request: emptyGrants }),
	).rejects.toMatchObject({ code: 'connection_profile' })

	const unbound = sessionRequestContext('user-1')
	stubCompile(unbound)
	await expect(
		authorizePackageCreate({ env, request: unbound }),
	).resolves.toBeUndefined()
	await expect(
		authorizePackageCreate({ env, request: null }),
	).rejects.toMatchObject({ code: 'unauthenticated' })
})

test('a member without package:create cannot create a saved package', async () => {
	const member = deriveRequestContext({
		user: { userId: personIdFromStored('user-1') },
		source: { kind: 'mcp-oauth' },
		orgBinding: {
			org: { id: ownerIdFromStored('org-1'), slug: 'org-1' },
			role: 'member',
		},
	})
	stubCompile(member)
	await expect(
		authorizePackageCreate({ env, request: member }),
	).rejects.toMatchObject({ permission: 'package:create' })
})

test('a surface permission list passes when any one permission is held', async () => {
	const member = deriveRequestContext({
		user: { userId: personIdFromStored('user-1') },
		source: { kind: 'mcp-oauth' },
		orgBinding: {
			org: { id: ownerIdFromStored('org-1'), slug: 'org-1' },
			role: 'member',
		},
	})
	stubCompile(member)
	await expect(
		authorizeSurface({ env, request: member }, ['package:write', 'org:read']),
	).resolves.toBeUndefined()
	await expect(
		authorizeSurface({ env, request: member }, [
			'package:write',
			'package:create',
		]),
	).rejects.toMatchObject({ permission: 'package:write' })
})

test('a request with no signed-in person is denied unless the surface touches no org data', async () => {
	const error = await authorize({ env, request: null }, 'package:read').catch(
		(caught: unknown) => caught,
	)
	expect(error).toBeInstanceOf(AuthorizationError)
	expect(error).toMatchObject({ code: 'unauthenticated', orgId: null })
	await expect(
		authorizeSurface({ env, request: null }, 'none'),
	).resolves.toBeUndefined()
	await expect(
		authorizeSurface({ env, request: null }, 'package:read'),
	).rejects.toBeInstanceOf(AuthorizationError)
})

test('lists show a package when the request holds any permission on it', () => {
	const pkg = storedPackageResource({
		id: 'pkg-1',
		userId: ownerIdFromStored('org-1'),
	})
	expect(canSeeResource(access(), pkg)).toBe(true)
	const executeOnly = access({
		profileGrants: [
			{ resourceType: 'package', resourceId: 'pkg-1', actions: ['execute'] },
		],
	})
	expect(canSeeResource(executeOnly, pkg)).toBe(true)
	expect(checkPermission(executeOnly, 'package:read', pkg).allowed).toBe(false)
	expect(canSeeResource(access({ profileGrants: [] }), pkg)).toBe(false)
	expect(
		canSeeResource(
			access(),
			storedPackageResource({
				id: 'pkg-1',
				userId: ownerIdFromStored('org-2'),
			}),
		),
	).toBe(false)
	const grantedOnly = access({
		isOwner: false,
		permissions: new Set(['search:read']),
		resourcePermissions: new Map([
			['package:pkg-1', new Set(['package:execute'])],
		]),
	})
	expect(canSeeResource(grantedOnly, pkg)).toBe(true)
	expect(canSeeResource(grantedOnly, packageResource({ id: 'pkg-2' }))).toBe(
		false,
	)
})

test('Automation keeps the connection profile of the credential that created it', async () => {
	const grants = [
		{ resourceType: 'package', resourceId: 'pkg-1', actions: ['read'] },
	]
	mocks.resolveConnectionProfileGrants.mockResolvedValueOnce(grants)
	const request = deriveRequestContext({
		user: { userId: personIdFromStored('user-1') },
		source: { kind: 'schedule', jobId: 'job-1' },
		profileName: ' work ',
	})
	stubCompile(request)
	const effective = await computeEffectivePermissions({ env, request })
	expect(mocks.resolveConnectionProfileGrants).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: ownerIdFromStored('user-1'),
		profileName: 'work',
	})
	expect(effective.profileGrants).toEqual(grants)
})

test('only a person behind the request is live; a triggered run and anything it starts never are', () => {
	const person = { userId: personIdFromStored('user-1'), username: 'ada' }
	const enablement = { id: 'en-1', enabler: person, role: 'owner' as const }
	const request = (source: RequestSource) =>
		deriveRequestContext({ user: person, source })
	const live = (source: RequestSource) => isLivePersonRequest(request(source))

	expect(
		(
			[
				{ kind: 'session' },
				{ kind: 'mcp-oauth' },
				{ kind: 'cli' },
				{ kind: 'api-token', tokenId: 'token-1' },
				{ kind: 'inherited', lineage: request({ kind: 'mcp-oauth' }) },
			] satisfies Array<RequestSource>
		).map(live),
	).toEqual([true, true, true, true, true])

	const webhookRun = request({ kind: 'webhook', sourceId: 'ep-1', enablement })
	expect(
		(
			[
				{ kind: 'package-app' },
				{ kind: 'schedule', jobId: 'job-1', enablement },
				{ kind: 'schedule', jobId: 'job-1' },
				{ kind: 'webhook', sourceId: 'ep-1', enablement },
				{
					kind: 'inbound-email',
					sourceId: 'message-1',
					sender: { kind: 'member', actor: person, role: 'owner' },
					enablement,
				},
				{ kind: 'platform-event', sourceId: 'event-1', enablement },
				inheritRequest(webhookRun),
				inheritRequest(request(inheritRequest(webhookRun))),
			] satisfies Array<RequestSource>
		).map(live),
	).toEqual([false, false, false, false, false, false, false, false])
	expect(isLivePersonRequest(null)).toBe(false)

	expect(() => assertLivePerson(webhookRun, 'orgMemberUpdate')).toThrow(
		LivePersonRequiredError,
	)
	expect(() => assertLivePerson(webhookRun, 'orgMemberUpdate')).toThrow(
		/Capability "orgMemberUpdate" needs a live person/,
	)
	expect(() =>
		assertLivePerson(request({ kind: 'session' }), 'orgMemberUpdate'),
	).not.toThrow()
})

test('nonInteractiveTriggerOf names the trigger behind a run no live person made', () => {
	const person = { userId: personIdFromStored('user-1'), username: 'ada' }
	const enablement = { id: 'en-1', enabler: person, role: 'owner' as const }
	const request = (source: RequestSource) =>
		deriveRequestContext({ user: person, source })
	const trigger = (source: RequestSource) =>
		nonInteractiveTriggerOf(request(source))
	const subscriptionRun = request({
		kind: 'platform-event',
		sourceId: 'event-1',
		enablement,
	})

	expect(
		(
			[
				{ kind: 'schedule', jobId: 'job-1', enablement },
				{ kind: 'webhook', sourceId: 'ep-1', enablement },
				{ kind: 'platform-event', sourceId: 'event-1', enablement },
				inheritRequest(subscriptionRun),
				{
					kind: 'inbound-email',
					sourceId: 'message-1',
					sender: { kind: 'inbox-owner' },
					enablement,
				},
				{ kind: 'schedule', jobId: 'job-1' },
				{ kind: 'package-app' },
			] satisfies Array<RequestSource>
		).map(trigger),
	).toEqual([
		{ type: 'job', credentialId: 'en-1' },
		{ type: 'webhook', credentialId: 'en-1' },
		{ type: 'subscription', credentialId: 'en-1' },
		{ type: 'subscription', credentialId: 'en-1' },
		{ type: 'email', credentialId: 'en-1' },
		{ type: 'job', credentialId: 'job-1' },
		{ type: 'package-app', credentialId: null },
	])

	expect(
		(
			[
				{ kind: 'session' },
				{ kind: 'mcp-oauth' },
				{ kind: 'cli' },
				{ kind: 'api-token', tokenId: 'token-1' },
				{ kind: 'inherited', lineage: request({ kind: 'cli' }) },
			] satisfies Array<RequestSource>
		).map(trigger),
	).toEqual([null, null, null, null, null])
	expect(nonInteractiveTriggerOf(null)).toBeNull()
	expect(
		nonInteractiveTriggerOf({ ...request({ kind: 'cli' }), actor: null }),
	).toEqual({ type: 'unattended', credentialId: null })
})

test('delegation, shares, and platform packages are stored packages, so another org is wrong_org', async () => {
	// Those routes no longer exist. A package reached through any of them is
	// the row's owning org, and a request bound to a different org is wrong_org.
	for (const label of [
		'@platform/delegated',
		'@owner/shared',
		'@kody/builtin',
	]) {
		const foreign = storedPackageResource({
			id: 'pkg-9',
			userId: ownerIdFromStored('org-2'),
			label,
		})
		expect(foreign.orgId).toBe(ownerIdFromStored('org-2'))
		const error = denial(checkPermission(access(), 'package:execute', foreign))
		expect(error.code).toBe('wrong_org')
		expect(error.message).toBe(`package ${label} belongs to another org.`)
	}
	expect(
		canSeeResource(
			access(),
			storedPackageResource({
				id: 'pkg-9',
				userId: ownerIdFromStored('org-2'),
			}),
		),
	).toBe(false)

	const request = sessionRequestContext('user-1')
	stubCompile(request)
	await expect(
		authorize(
			{ env, request },
			'package:read',
			storedPackageResource({
				id: 'pkg-9',
				userId: ownerIdFromStored('org-2'),
			}),
		),
	).rejects.toMatchObject({ code: 'wrong_org' })
	await expect(
		authorize(
			{ env, request },
			'package:read',
			storedPackageResource({
				id: 'pkg-1',
				userId: ownerIdFromStored('user-1'),
			}),
		),
	).resolves.toBeUndefined()
})

test('deep call sites read the permissions bound for the request', async () => {
	const request = sessionRequestContext('user-1')
	stubCompile(request)
	const bound = await runWithRequestPermissions({ env, request }, async () =>
		getRequestPermissions(),
	)
	expect(bound).toBe(await computeEffectivePermissions({ env, request }))
	await expect(
		runWithRequestPermissions({ env, request: null }, async () =>
			getRequestPermissions(),
		),
	).resolves.toBeUndefined()
})
