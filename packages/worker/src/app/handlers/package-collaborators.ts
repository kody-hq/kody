import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	inviteCreateCapability,
	inviteRevokeCapability,
} from '#mcp/capabilities/access/invites.ts'
import { isMcpCallerError } from '#mcp/caller-error.ts'
import {
	packageCollaboratorRemoveCapability,
	setPackageCollaboratorAccess,
} from '#mcp/capabilities/access/package-collaborators.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	AuthorizationError,
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { operationResult } from '../operation-result.ts'
import { getInviteById } from '#worker/orgs/access-writes.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import {
	listPackageCollaborators,
	listPendingPackageInvites,
} from '#worker/orgs/package-collaborators.ts'
import { loadOrgBindingForSlug, type OrgBinding } from '#worker/orgs/repo.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import {
	type PackageCollaboratorsView,
	type PackageCollaboratorsWriteResult,
	type PackageCollaboratorInviteCreated,
	readPackageCollaboratorInvitee,
	packageCollaboratorInviteeLabel,
	type PackageCollaboratorPreset,
} from '#universal/package-collaborators.ts'

type AppUser = NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>

export type CollaboratorsScope = {
	ctx: CapabilityContext
	org: OrgBinding['org']
	orgSlug: string
	personal: boolean
	savedPackage: { id: string; kodyId: string; name: string }
}

/**
 * The package as the signed-in person sees it, bound to the `:username` org
 * (members and outside collaborators alike). Not found when they cannot read
 * the package there; forbidden when they can read it but not manage access.
 */
export async function loadCollaboratorsScope(input: {
	env: Env
	request: Request
	user: AppUser
	username: string
	kodyId: string
}): Promise<
	| { kind: 'ok'; scope: CollaboratorsScope }
	| { kind: 'not_found' }
	| { kind: 'forbidden' }
> {
	const { env, user } = input
	const binding = await loadOrgBindingForSlug(
		env.APP_DB,
		user.mcpUser.userId,
		input.username,
	)
	if (!binding) return { kind: 'not_found' }
	const savedPackage = await resolveSavedPackage({
		db: env.APP_DB,
		userId: binding.org.id,
		packageIdOrKodyId: input.kodyId.trim(),
	})
	if (!savedPackage) return { kind: 'not_found' }
	const callerContext = createMcpCallerContext({
		baseUrl: getAppBaseUrl({ env, requestUrl: input.request.url }),
		source: { kind: 'session' },
		executionOrigin: 'interactive',
		user: user.mcpUser,
		orgBinding: binding,
	})
	if (!callerContext.request) return { kind: 'not_found' }
	const access = await computeEffectivePermissions({
		env,
		request: callerContext.request,
	})
	const resource = packageResource({
		id: savedPackage.id,
		userId: savedPackage.userId,
		label: savedPackage.kodyId,
	})
	if (!checkPermission(access, 'package:read', resource).allowed) {
		return { kind: 'not_found' }
	}
	if (!checkPermission(access, 'package:manage_access', resource).allowed) {
		return { kind: 'forbidden' }
	}
	return {
		kind: 'ok',
		scope: {
			ctx: { env, callerContext },
			org: binding.org,
			orgSlug: binding.org.slug ?? input.username,
			personal: await isPersonalOrg(env.APP_DB, binding.org.id),
			savedPackage: {
				id: savedPackage.id,
				kodyId: savedPackage.kodyId,
				name: savedPackage.name,
			},
		},
	}
}

async function buildCollaboratorsView(
	scope: CollaboratorsScope,
): Promise<PackageCollaboratorsView> {
	const db = scope.ctx.env.APP_DB
	const target = { db, orgId: scope.org.id, packageId: scope.savedPackage.id }
	const [listed, invites] = await Promise.all([
		listPackageCollaborators(target),
		scope.personal ? listPendingPackageInvites(target) : Promise.resolve([]),
	])
	return {
		ok: true,
		package: scope.savedPackage,
		org: { slug: scope.orgSlug, personal: scope.personal },
		collaborators: listed.collaborators,
		invites,
		options: listed.options,
	}
}

type CollaboratorsInput = {
	env: Env
	request: Request
	user: AppUser
	username: string
	kodyId: string
}
async function authorizedScope(input: CollaboratorsInput) {
	const loaded = await loadCollaboratorsScope(input)
	if (loaded.kind === 'not_found')
		return {
			error: operationResult(
				{ ok: false as const, error: 'Package not found.' },
				404,
			),
		}
	if (loaded.kind === 'forbidden')
		return {
			error: operationResult(
				{
					ok: false as const,
					error:
						'You need Manage on this package to see and change who can use it.',
				},
				403,
			),
		}
	return { scope: loaded.scope }
}
export async function readPackageCollaborators(input: CollaboratorsInput) {
	const loaded = await authorizedScope(input)
	if (loaded.error) return loaded.error
	return operationResult(await buildCollaboratorsView(loaded.scope))
}
export function grantPackageCollaborator(
	input: CollaboratorsInput & {
		subjectType: 'user' | 'team'
		subjectId: string
		preset: PackageCollaboratorPreset
	},
) {
	return changeCollaborator(input, async ({ ctx, savedPackage }) => {
		await setPackageCollaboratorAccess(
			{
				package_id: savedPackage.id,
				...(input.subjectType === 'team'
					? { team_id: input.subjectId }
					: { user_id: input.subjectId }),
				preset: input.preset,
			},
			ctx,
		)
	})
}
export function revokePackageCollaborator(
	input: CollaboratorsInput & { grantId: string },
) {
	return changeCollaborator(input, async ({ ctx, savedPackage }) => {
		await packageCollaboratorRemoveCapability.handler(
			{ package_id: savedPackage.id, grant_id: input.grantId },
			ctx,
		)
	})
}
class CollaboratorChangeRefused extends Error {
	readonly status: 400 | 404
	constructor(message: string, status: 400 | 404 = 400) {
		super(message)
		this.status = status
	}
}
function requirePersonalOrg(scope: CollaboratorsScope) {
	if (scope.personal) return
	throw new CollaboratorChangeRefused(
		'Invites from this tab are for personal organizations. In a team organization, add teams and members instead.',
	)
}

export function createPackageCollaboratorInvite(
	input: CollaboratorsInput & {
		invitee: string
		preset: PackageCollaboratorPreset
	},
) {
	return changeCollaborator(input, async (scope) => {
		requirePersonalOrg(scope)
		const created = await inviteCreateCapability.handler(
			{
				kind: 'grant',
				...readPackageCollaboratorInvitee(input.invitee),
				resource_type: 'package',
				resource_id: scope.savedPackage.id,
				preset: input.preset,
			},
			scope.ctx,
		)
		return {
			id: created.invite.id,
			expiresAt: created.invite.expires_at,
			inviteeLabel: packageCollaboratorInviteeLabel({
				inviteeEmail: created.invite.invitee_email,
				inviteeUsername: created.invite.invitee_username,
			}),
			preset: input.preset,
			prompt: created.prompt,
		}
	})
}

export function revokePackageCollaboratorInvite(
	input: CollaboratorsInput & { inviteId: string },
) {
	return changeCollaborator(input, async (scope) => {
		requirePersonalOrg(scope)
		const invite = await getInviteById({
			db: scope.ctx.env.APP_DB,
			orgId: scope.org.id,
			inviteId: input.inviteId,
		})
		if (
			!invite ||
			invite.kind !== 'grant' ||
			invite.resourceType !== 'package' ||
			invite.resourceId !== scope.savedPackage.id ||
			invite.status !== 'pending'
		) {
			throw new CollaboratorChangeRefused(
				'That invite is no longer pending.',
				404,
			)
		}
		await inviteRevokeCapability.handler({ invite_id: invite.id }, scope.ctx)
	})
}

async function changeCollaborator(
	input: CollaboratorsInput,
	apply: (
		scope: CollaboratorsScope,
	) => Promise<PackageCollaboratorInviteCreated | void>,
) {
	const loaded = await authorizedScope(input)
	if (loaded.error) return loaded.error
	let invite: PackageCollaboratorInviteCreated | void
	try {
		invite = await apply(loaded.scope)
	} catch (error) {
		if (error instanceof CollaboratorChangeRefused)
			return operationResult(
				{ ok: false as const, error: error.message },
				error.status,
			)
		if (error instanceof AuthorizationError)
			return operationResult({ ok: false as const, error: error.message }, 403)
		if (isMcpCallerError(error) && error instanceof Error)
			return operationResult({ ok: false as const, error: error.message }, 400)
		throw error
	}
	const result: PackageCollaboratorsWriteResult = invite
		? { ok: true, invite }
		: { ok: true }
	return operationResult(result)
}
