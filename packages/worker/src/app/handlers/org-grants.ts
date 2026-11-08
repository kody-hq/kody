import type {
	AuthenticatedAppUser,
	readAuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	orgHasPermission,
	resolveOrgManagementAccess,
	type ManagedOrg,
} from '#app/org-management-access.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	authorizeGrantRevoke,
	authorizeGrantTarget,
	resolveAuthorizedGrantPermissions,
} from '#mcp/capabilities/access/shared.ts'
import type {
	OrgGrantPersonView,
	OrgGrantsLoaderData,
	OrgWideReadSubjectView,
} from '#universal/loader-data.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import {
	getGrantById,
	isGrantResourceType,
	listGrants,
	softDeleteGrant,
	upsertGrant,
	type GrantSubject,
} from '#worker/orgs/access-writes.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import {
	listOrgGrantsForView,
	type ListedOrgGrant,
} from '#worker/orgs/org-grants-view.ts'
import { listOrgMembers } from '#worker/orgs/org-members-list.ts'
import { listOutsideCollaborators } from '#worker/orgs/org-collaborators-list.ts'
import { listTeams } from '#worker/orgs/org-teams-list.ts'
import {
	isOrgWideManagePermission,
	isOrgWideReadPermission,
	orgWideManagePermissions,
	orgWideReadPermissions,
} from '@kody-internal/shared/grant-presets.ts'
import {
	isOrgCreatePermission,
	orgCreateAccessOptions,
} from '#universal/org-create-access.ts'
import {
	isOrgPermission,
	type OrgPermission,
} from '@kody-internal/shared/org-permissions.ts'

/**
 * Same resource check as grant revoke. Authorization and caller denials mean
 * this viewer cannot revoke the grant; anything else still fails the request.
 */
export async function grantRevokeAllowed(
	env: Env,
	user: AuthenticatedAppUser,
	grant: { resourceType: string; resourceId: string },
) {
	if (!isGrantResourceType(grant.resourceType)) return false
	try {
		await authorizeGrantRevoke(
			{
				env,
				callerContext: {
					user: user.mcpUser,
					request: user.request,
				},
			},
			grant.resourceType,
			grant.resourceId,
		)
		return true
	} catch (error) {
		// AuthorizationError is an McpCallerError. Both are denials.
		if (error instanceof McpCallerError) return false
		throw error
	}
}

export async function loadOrgGrantsData(input: {
	env: Env
	user: AuthenticatedAppUser
	org: ManagedOrg
}): Promise<OrgGrantsLoaderData> {
	const canManage = await orgHasPermission(
		input.env,
		input.user,
		'member:write',
	)
	const grants = await listOrgGrantsForView(input.env.APP_DB, input.org.id)
	return {
		ok: true,
		org: input.org,
		canManage,
		orgWideRead:
			canManage && !input.org.personal
				? {
						subjects: await listOrgWideReadSubjects(
							input.env.APP_DB,
							input.org.id,
							grants,
						),
					}
				: null,
		grants: await Promise.all(
			grants.map(async (grant) => ({
				...grant,
				canRevoke: await grantRevokeAllowed(input.env, input.user, grant),
			})),
		),
		people:
			canManage && !input.org.personal
				? await listGrantPeople(input.env.APP_DB, input.org.id)
				: [],
	}
}

/** Non-owner members, then outside collaborators, for "Give someone access". */
async function listGrantPeople(
	db: D1Database,
	orgId: string,
): Promise<Array<OrgGrantPersonView>> {
	const [members, outside] = await Promise.all([
		listOrgMembers(db, orgId),
		listOutsideCollaborators(db, orgId),
	])
	return [
		...members
			.filter((member) => member.role !== 'owner' && member.role !== 'admin')
			.map((member) => ({
				userId: member.userId,
				label: memberLabel(member),
				kind: 'member' as const,
			})),
		...outside.map((person) => ({
			userId: person.userId,
			label: memberLabel(person),
			kind: 'collaborator' as const,
		})),
	]
}

export async function revokeOrganizationGrant({
	request,
	env,
	user,
	orgSlug,
	...fields
}: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	grantId?: unknown
	orgSlug?: string
}) {
	const access = await resolveOrgManagementAccess({
		request,
		orgSlug,
		env,
		user,
		permission: 'member:write',
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}

	const grantId =
		typeof fields.grantId === 'string' ? fields.grantId.trim() : ''
	if (!grantId) {
		return operationResult({ ok: false, error: 'A grant id is required.' }, 400)
	}
	const grant = await getGrantById({
		db: env.APP_DB,
		orgId: access.org.id,
		grantId,
	})
	if (!grant || !isGrantResourceType(grant.resourceType)) {
		return operationResult(
			{ ok: false, error: 'Grant was not found in this organization.' },
			400,
		)
	}
	try {
		await authorizeGrantRevoke(
			{
				env,
				callerContext: {
					user: user.mcpUser,
					request: user.request,
				},
			},
			grant.resourceType,
			grant.resourceId,
		)
	} catch (error) {
		if (error instanceof AuthorizationError) {
			return operationResult({ ok: false, error: error.message }, 403)
		}
		if (error instanceof McpCallerError) {
			return operationResult({ ok: false, error: error.message }, 400)
		}
		throw error
	}
	try {
		await softDeleteGrant({
			db: env.APP_DB,
			orgId: access.org.id,
			grantId: grant.id,
			audit: orgAuditWriterFromRequest(env, user.request),
		})
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Unable to revoke that grant.'
		return operationResult({ ok: false, error: message }, 400)
	}
	return operationResult({ ok: true as const })
}

function subjectKey(subject: GrantSubject) {
	return `${subject.type}:${subject.id}`
}

function memberLabel(member: {
	username: string | null
	displayName: string | null
}) {
	if (member.username) return `@${member.username}`
	return member.displayName?.trim() || 'Unnamed member'
}

/**
 * Members (Owners already hold every permission) and teams an organization
 * grant can give read-only access to, with the reads each already holds.
 */
async function listOrgWideReadSubjects(
	db: D1Database,
	orgId: string,
	grants: ReadonlyArray<ListedOrgGrant>,
): Promise<Array<OrgWideReadSubjectView>> {
	const readsBySubject = new Map<string, Array<string>>()
	const createsBySubject = new Map<string, Array<string>>()
	const managesBySubject = new Map<string, Array<string>>()
	for (const grant of grants) {
		if (grant.resourceType !== 'org' || grant.resourceId !== orgId) continue
		const key = subjectKey({ type: grant.subjectType, id: grant.subjectId })
		readsBySubject.set(key, [
			...(readsBySubject.get(key) ?? []),
			...grant.permissions.filter(isOrgWideReadPermission),
		])
		createsBySubject.set(key, [
			...(createsBySubject.get(key) ?? []),
			...grant.permissions.filter(isOrgCreatePermission),
		])
		managesBySubject.set(key, [
			...(managesBySubject.get(key) ?? []),
			...grant.permissions.filter(isOrgWideManagePermission),
		])
	}
	const [members, teams] = await Promise.all([
		listOrgMembers(db, orgId),
		listTeams(db, orgId),
	])
	const subjects: Array<OrgWideReadSubjectView> = []
	for (const member of members) {
		if (member.role === 'owner' || member.role === 'admin') continue
		const key = subjectKey({ type: 'user', id: member.userId })
		subjects.push({
			key,
			kind: 'user',
			label: memberLabel(member),
			reads: readsBySubject.get(key) ?? [],
			creates: createsBySubject.get(key) ?? [],
			manages: managesBySubject.get(key) ?? [],
		})
	}
	for (const team of teams) {
		const key = subjectKey({ type: 'team', id: team.id })
		subjects.push({
			key,
			kind: 'team',
			label: `${team.name} (@${team.slug})`,
			reads: readsBySubject.get(key) ?? [],
			creates: createsBySubject.get(key) ?? [],
			manages: managesBySubject.get(key) ?? [],
		})
	}
	return subjects
}

async function resolveOrgWideReadSubject(
	db: D1Database,
	orgId: string,
	raw: string,
): Promise<GrantSubject | null> {
	const [type, id = ''] = raw.split(/:(.*)/s, 2)
	if (!id) return null
	if (type === 'user') {
		const row = await db
			.prepare(
				`SELECT role FROM org_memberships
				 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
			)
			.bind(orgId, id)
			.first<{ role: string }>()
		if (!row || row.role === 'owner' || row.role === 'admin') return null
		return { type: 'user', id }
	}
	if (type === 'team') {
		const row = await db
			.prepare(
				`SELECT id FROM teams WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
			)
			.bind(id, orgId)
			.first<{ id: string }>()
		return row ? { type: 'team', id } : null
	}
	return null
}

type OrganizationAccessKind = 'read' | 'create' | 'manage'

const organizationAccessKinds = {
	read: {
		allows: isOrgWideReadPermission,
		onlyError: `Only read access can be granted here: ${orgWideReadPermissions.join(', ')}.`,
		personalError:
			'A personal organization has no members to grant org-wide read access to.',
		emptyError: 'Pick at least one kind of read access.',
	},
	create: {
		allows: isOrgCreatePermission,
		onlyError: `Only create access can be granted here: ${orgCreateAccessOptions.map((option) => option.permission).join(', ')}.`,
		personalError:
			'A personal organization has no members to grant create access to.',
		emptyError: 'Pick at least one kind of create access.',
	},
	manage: {
		allows: isOrgWideManagePermission,
		onlyError: `Only manage access can be granted here: ${orgWideManagePermissions.join(', ')}.`,
		personalError:
			'A personal organization has no members to grant org-wide manage access to.',
		emptyError: 'Pick at least one kind of manage access.',
	},
} satisfies Record<
	OrganizationAccessKind,
	{
		allows: (permission: unknown) => boolean
		onlyError: string
		personalError: string
		emptyError: string
	}
>

/**
 * Set which read-only resource permissions a member or team holds on the
 * organization. Other permissions on that subject's organization grant are
 * kept as they are; nothing here can add a write.
 */
export async function grantOrganizationReadAccess(
	input: OrganizationAccessInput,
) {
	return setOrganizationAccess(input, 'read')
}

/**
 * Set which create permissions (`package:create`, `secret:create`,
 * `integration:create`) a member or team holds on the organization, on top of
 * what the org's member settings give every Member. Other permissions on that
 * subject's organization grant are kept as they are.
 */
export async function grantOrganizationCreateAccess(
	input: OrganizationAccessInput,
) {
	return setOrganizationAccess(input, 'create')
}

/**
 * Set which org-wide package and app manage permissions a member or team
 * holds. Only an Owner may add them. Each saved kind also gets its read
 * permission, which stays when manage is removed. Other permissions on that
 * subject's organization grant are kept as they are.
 */
export async function grantOrganizationManageAccess(
	input: OrganizationAccessInput,
) {
	return setOrganizationAccess(input, 'manage')
}

type OrganizationAccessInput = {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	subject?: unknown
	permissions?: unknown
	orgSlug?: string
}

async function setOrganizationAccess(
	{ request, env, user, orgSlug, ...fields }: OrganizationAccessInput,
	kind: OrganizationAccessKind,
) {
	const config = organizationAccessKinds[kind]
	const access = await resolveOrgManagementAccess({
		request,
		orgSlug,
		env,
		user,
		permission: 'member:write',
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}
	if (access.org.personal) {
		return operationResult(
			{
				ok: false,
				error: config.personalError,
			},
			400,
		)
	}
	const requested = Array.isArray(fields.permissions) ? fields.permissions : []
	const chosen: Array<OrgPermission> = []
	for (const permission of requested) {
		if (!isOrgPermission(permission) || !config.allows(permission)) {
			return operationResult({ ok: false, error: config.onlyError }, 400)
		}
		if (!chosen.includes(permission)) chosen.push(permission)
	}
	const subject = await resolveOrgWideReadSubject(
		env.APP_DB,
		access.org.id,
		typeof fields.subject === 'string' ? fields.subject.trim() : '',
	)
	if (!subject) {
		return operationResult(
			{ ok: false, error: 'Choose a member or team in this organization.' },
			400,
		)
	}
	const ctx = {
		env,
		callerContext: { user: user.mcpUser, request: user.request },
	}
	const existing = await listGrants({
		db: env.APP_DB,
		orgId: access.org.id,
		resourceType: 'org',
		resourceId: access.org.id,
		subjectType: subject.type,
		subjectId: subject.id,
	})
	const keptFrom = (grants: typeof existing) =>
		grants
			.flatMap((grant) => grant.permissions)
			.filter(
				(permission): permission is OrgPermission =>
					isOrgPermission(permission) && !config.allows(permission),
			)
	const kept = keptFrom(existing)
	// Saving clears a past expiry, so only a live grant's permissions skip the Owner check.
	const now = new Date().toISOString()
	const liveKept = keptFrom(
		existing.filter((grant) => !grant.expiresAt || grant.expiresAt > now),
	)
	const permissions = [
		...new Set([
			...kept,
			...chosen,
			...(kind === 'manage' ? orgWideReadsFor(chosen) : []),
		]),
	]
	if (permissions.length === 0 && existing.length === 0) {
		return operationResult({ ok: false, error: config.emptyError }, 400)
	}
	try {
		await authorizeGrantTarget(ctx, 'org', access.org.id)
		if (permissions.length === 0) {
			// Unchecking the last box clears a grant that held only these.
			for (const grant of existing) {
				await softDeleteGrant({
					db: env.APP_DB,
					orgId: access.org.id,
					grantId: grant.id,
					audit: orgAuditWriterFromRequest(env, user.request),
				})
			}
			return operationResult({ ok: true as const, permissions: chosen })
		}
		const resolved = await resolveAuthorizedGrantPermissions(ctx, {
			family: 'org',
			permissions,
			alreadyHeld: liveKept,
		})
		await upsertGrant({
			db: env.APP_DB,
			orgId: access.org.id,
			resourceType: 'org',
			resourceId: access.org.id,
			family: 'org',
			subject,
			preset: null,
			permissions: resolved,
			createdByUserId: user.mcpUser.userId,
			audit: orgAuditWriterFromRequest(env, user.request),
		})
	} catch (error) {
		if (error instanceof AuthorizationError) {
			return operationResult({ ok: false, error: error.message }, 403)
		}
		if (error instanceof McpCallerError) {
			return operationResult({ ok: false, error: error.message }, 400)
		}
		throw error
	}
	return operationResult({ ok: true as const, permissions: chosen })
}

/** The read permission each org-wide manage permission's kind needs. */
function orgWideReadsFor(permissions: ReadonlyArray<OrgPermission>) {
	return [
		...new Set(
			permissions.map((permission): OrgPermission =>
				permission.startsWith('app:') ? 'app:read' : 'package:read',
			),
		),
	]
}
