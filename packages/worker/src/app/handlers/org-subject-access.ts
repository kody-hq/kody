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
import { accessGrantCapability } from '#mcp/capabilities/access/access-grants.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import type {
	OrgSubjectAccessGrant,
	OrgSubjectAccessLoaderData,
	OrgSubjectAccessOption,
	OrgSubjectAccessWriteResult,
} from '#universal/loader-data.ts'
import type { OrgSubjectAccessItem } from '#universal/org-people-mutations.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	packageResource,
	type EffectivePermissions,
} from '#worker/authorization/authorize.ts'
import { buildUserAvatarUrl } from '#worker/community/public-urls.ts'
import {
	credentialPermissionFamily,
	credentialResource,
	listOrgCredentialsByIds,
} from '#worker/credentials/credential-ids.ts'
import { listCredentialsForViewer } from '#worker/credentials/credential-list.ts'
import { listGrants } from '#worker/orgs/access-writes.ts'
import { listOrgGrantsForView } from '#worker/orgs/org-grants-view.ts'
import { listTeams } from '#worker/orgs/org-teams-list.ts'
import type { OrgRole } from '@kody-internal/shared/request-context.ts'
import { countOrgMembers, grantRevokeAllowed } from './org-grants.ts'

const maxPackageOptions = 200
const maxCredentialOptions = 200

type AccessSubject = {
	userId: string
	username: string | null
	displayName: string | null
	avatarKey: string | null
	role: OrgRole | null
}

/**
 * A person this organization's access page can describe: a member, or someone
 * outside it who already holds a live grant here. Anyone else is not a subject;
 * new people join through an invite first.
 */
async function loadAccessSubject(
	db: D1Database,
	orgId: string,
	userId: string,
): Promise<AccessSubject | null> {
	const row = await db
		.prepare(
			`SELECT u.stable_user_id AS user_id,
			        u.username AS username,
			        u.display_name AS display_name,
			        u.avatar_key AS avatar_key,
			        m.role AS role
			 FROM users u
			 LEFT JOIN org_memberships m
			   ON m.user_id = u.stable_user_id
			  AND m.org_id = ?
			  AND m.deleted_at IS NULL
			 WHERE u.deleted_at IS NULL AND u.stable_user_id = ?`,
		)
		.bind(orgId, userId)
		.first<{
			user_id: string
			username: string | null
			display_name: string | null
			avatar_key: string | null
			role: OrgRole | null
		}>()
	if (!row) return null
	const subject = {
		userId: row.user_id,
		username: row.username,
		displayName: row.display_name,
		avatarKey: row.avatar_key,
		role: row.role ?? null,
	}
	if (subject.role) return subject
	const grants = await listGrants({
		db,
		orgId,
		subjectType: 'user',
		subjectId: userId,
	})
	return grants.length > 0 ? subject : null
}

async function listSubjectTeamIds(
	db: D1Database,
	orgId: string,
	userId: string,
) {
	const rows = await db
		.prepare(
			`SELECT tm.team_id AS team_id
			 FROM team_members tm
			 JOIN teams t ON t.id = tm.team_id
			 WHERE t.org_id = ?
			   AND t.deleted_at IS NULL
			   AND tm.deleted_at IS NULL
			   AND tm.user_id = ?`,
		)
		.bind(orgId, userId)
		.all<{ team_id: string }>()
	return new Set((rows.results ?? []).map((row) => row.team_id))
}

/** Whose access a page or grant form is about. */
export type OrgAccessSubjectRef =
	| { kind: 'user'; userId: string }
	| { kind: 'team'; teamId: string }
	| { kind: 'org' }

/** Read `user:<id>`, `team:<id>`, or `org`. Null for anything else. */
export function parseOrgAccessSubjectKey(
	key: string,
): OrgAccessSubjectRef | null {
	if (key === 'org') return { kind: 'org' }
	const [kind, ...rest] = key.split(':')
	const id = rest.join(':').trim()
	if (!id) return null
	if (kind === 'user') return { kind: 'user', userId: id }
	if (kind === 'team') return { kind: 'team', teamId: id }
	return null
}

async function loadAccessTeam(db: D1Database, orgId: string, teamId: string) {
	const teams = await listTeams(db, orgId)
	return teams.find((team) => team.id === teamId) ?? null
}

/**
 * One subject's access in this organization: for a person, grants made to
 * them directly, through a team, or to everyone in the organization; for a
 * team, its own grants plus what everyone in the organization has; for the
 * whole organization, its own grants. Also what the viewer may add. Null
 * when the subject is not one here.
 */
export async function loadOrgSubjectAccessData(input: {
	env: Env
	user: AuthenticatedAppUser
	org: ManagedOrg
	userId?: string
	subject?: OrgAccessSubjectRef
}): Promise<OrgSubjectAccessLoaderData | null> {
	const ref: OrgAccessSubjectRef | null =
		input.subject ??
		(input.userId ? { kind: 'user', userId: input.userId } : null)
	if (!ref) return null
	if (ref.kind === 'user') {
		return loadPersonAccess({ ...input, userId: ref.userId })
	}
	if (input.org.personal) return null
	const db = input.env.APP_DB
	const team =
		ref.kind === 'team'
			? await loadAccessTeam(db, input.org.id, ref.teamId)
			: null
	if (ref.kind === 'team' && !team) return null
	const [canManage, allGrants, memberCount] = await Promise.all([
		orgHasPermission(input.env, input.user, 'member:write'),
		listOrgGrantsForView(db, input.org.id),
		countOrgMembers(db, input.org.id),
	])
	const grants: Array<OrgSubjectAccessGrant> = []
	for (const grant of allGrants) {
		const via = team
			? grant.subjectType === 'team' && grant.subjectId === team.id
				? 'direct'
				: grant.subjectType === 'org'
					? 'everyone'
					: null
			: grant.subjectType === 'org'
				? 'direct'
				: null
		if (!via) continue
		grants.push({
			...grant,
			via,
			canRevoke:
				via === 'direct' && canManage
					? await grantRevokeAllowed(input.env, input.user, grant)
					: false,
		})
	}
	return {
		ok: true,
		org: input.org,
		canManage,
		subject: team
			? {
					kind: 'team',
					teamId: team.id,
					slug: team.slug,
					name: team.name,
					memberCount: team.memberCount,
				}
			: { kind: 'org', memberCount },
		grants,
		options: canManage ? await loadGrantOptions(input, grants) : null,
	}
}

async function loadPersonAccess(input: {
	env: Env
	user: AuthenticatedAppUser
	org: ManagedOrg
	userId: string
}): Promise<OrgSubjectAccessLoaderData | null> {
	const db = input.env.APP_DB
	const subject = await loadAccessSubject(db, input.org.id, input.userId)
	if (!subject) return null
	const [canManage, teamIds, allGrants] = await Promise.all([
		orgHasPermission(input.env, input.user, 'member:write'),
		listSubjectTeamIds(db, input.org.id, subject.userId),
		listOrgGrantsForView(db, input.org.id),
	])
	const grants: Array<OrgSubjectAccessGrant> = []
	for (const grant of allGrants) {
		const via =
			grant.subjectType === 'user' && grant.subjectId === subject.userId
				? 'direct'
				: grant.subjectType === 'team' && teamIds.has(grant.subjectId)
					? 'team'
					: grant.subjectType === 'org' && subject.role
						? 'everyone'
						: null
		if (!via) continue
		grants.push({
			...grant,
			via,
			canRevoke:
				via === 'direct' && canManage
					? await grantRevokeAllowed(input.env, input.user, grant)
					: false,
		})
	}
	const options =
		canManage && subject.role !== 'owner' && subject.role !== 'admin'
			? await loadGrantOptions(input, grants)
			: null
	return {
		ok: true,
		org: input.org,
		canManage,
		subject: {
			kind: 'user',
			userId: subject.userId,
			username: subject.username,
			displayName: subject.displayName,
			avatarUrl: subject.username
				? buildUserAvatarUrl({
						username: subject.username,
						avatarKey: subject.avatarKey,
					})
				: null,
			role: subject.role,
		},
		grants,
		options,
	}
}

/** Packages and credentials in this organization the viewer may share. */
async function loadGrantOptions(
	input: { env: Env; user: AuthenticatedAppUser; org: ManagedOrg },
	grants: ReadonlyArray<OrgSubjectAccessGrant>,
): Promise<{
	packages: Array<OrgSubjectAccessOption>
	credentials: Array<OrgSubjectAccessOption>
}> {
	const db = input.env.APP_DB
	const direct = new Set(
		grants
			.filter((grant) => grant.via === 'direct')
			.map((grant) => `${grant.resourceType}:${grant.resourceId}`),
	)
	const access = await computeEffectivePermissions({
		env: input.env,
		request: input.user.request,
	})
	const packageRows = await db
		.prepare(
			`SELECT id, name, kody_id, has_app FROM saved_packages
			 WHERE user_id = ? AND deleted_at IS NULL
			 ORDER BY name ASC LIMIT ?`,
		)
		.bind(input.org.id, maxPackageOptions)
		.all<{
			id: string
			name: string | null
			kody_id: string | null
			has_app: number | null
		}>()
	const packages: Array<OrgSubjectAccessOption> = []
	for (const row of packageRows.results ?? []) {
		if (direct.has(`package:${row.id}`)) continue
		const label = row.name?.trim() || row.kody_id || row.id
		const resource = packageResource({
			id: row.id,
			userId: input.org.id,
			label,
		})
		if (!checkPermission(access, 'package:manage_access', resource).allowed) {
			continue
		}
		const appGrantable =
			Boolean(row.has_app) &&
			!direct.has(`app:${row.id}`) &&
			checkPermission(access, 'app:manage_access', {
				type: 'app',
				id: row.id,
				orgId: input.org.id,
				label,
			}).allowed
		packages.push({
			resourceType: 'package',
			resourceId: row.id,
			label,
			detail: row.kody_id && row.kody_id !== label ? row.kody_id : null,
			appGrantable,
		})
	}
	return {
		packages,
		credentials: await loadCredentialOptions(input, access, direct),
	}
}

async function loadCredentialOptions(
	input: { env: Env; user: AuthenticatedAppUser; org: ManagedOrg },
	access: EffectivePermissions,
	direct: ReadonlySet<string>,
): Promise<Array<OrgSubjectAccessOption>> {
	const listed = (
		await listCredentialsForViewer({
			env: input.env,
			request: input.user.request,
		})
	).filter(
		(item) =>
			item.scope === 'org' &&
			item.packageId === null &&
			!direct.has(`credential:${item.id}`),
	)
	const rows = await listOrgCredentialsByIds(
		input.env.APP_DB,
		input.org.id,
		listed.map((item) => item.id),
	)
	const options: Array<OrgSubjectAccessOption> = []
	for (const item of listed) {
		const credential = rows.get(item.id)
		if (!credential?.live) continue
		const family = credentialPermissionFamily(credential.kind)
		const allowed = checkPermission(
			access,
			family === 'secret'
				? 'secret:manage_access'
				: 'integration:manage_access',
			credentialResource(input.org.id, credential),
		).allowed
		if (!allowed) continue
		options.push({
			resourceType: 'credential',
			resourceId: item.id,
			label: item.name,
			detail: [
				credentialKindLabel(item.kind),
				item.lockedToPackageIds.length > 0
					? 'Only runs of certain packages can use it'
					: null,
			]
				.filter(Boolean)
				.join(' · '),
			appGrantable: false,
		})
		if (options.length >= maxCredentialOptions) break
	}
	return options
}

function credentialKindLabel(kind: string) {
	switch (kind) {
		case 'secret':
			return 'Secret'
		case 'oauth':
			return 'Integration'
		case 'mcp':
			return 'MCP server'
		case 'url':
			return 'URL'
		case 'login':
			return 'Login'
		case 'signing':
			return 'Signing key'
		default:
			return 'Credential'
	}
}

/**
 * Add or change several grants for one person, a team, or everyone in the
 * organization. Each item runs `accessGrant` as the signed-in person, so every
 * authorization, audit, and warning is the same as an agent's call. Items are
 * independent: one failure does not undo the others, and each reports its own
 * result.
 */
export async function grantOrganizationSubjectAccess({
	request,
	env,
	user,
	orgSlug,
	userId,
	subject: subjectKey,
	items,
}: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	orgSlug?: string
	userId?: string
	subject?: string
	items: ReadonlyArray<OrgSubjectAccessItem>
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
	if (user.request.org.id !== access.org.id) {
		return operationResult({ ok: false, error: 'Organization not found.' }, 404)
	}
	const ref: OrgAccessSubjectRef | null =
		userId && !subjectKey
			? { kind: 'user', userId }
			: subjectKey && !userId
				? parseOrgAccessSubjectKey(subjectKey)
				: null
	if (!ref) {
		return operationResult(
			{ ok: false, error: 'Choose one person, team, or the organization.' },
			400,
		)
	}
	const target = await resolveGrantTarget(env.APP_DB, access.org, ref)
	if (!target.ok) {
		return operationResult({ ok: false, error: target.error }, 400)
	}
	const ctx = {
		env,
		callerContext: createMcpCallerContext({
			baseUrl: getAppBaseUrl({ env, requestUrl: request.url }),
			source: { kind: 'session' },
			executionOrigin: 'interactive',
			user: user.mcpUser,
			orgBinding: {
				org: user.request.org,
				role: user.request.membership?.role ?? null,
			},
		}),
	}
	const results: Array<OrgSubjectAccessWriteResult> = []
	for (const item of items) {
		try {
			const saved = await accessGrantCapability.handler(
				{
					resource_type: item.resourceType,
					resource_id: item.resourceId,
					subject_type: target.subjectType,
					subject_id: target.subjectId,
					preset: item.preset,
				},
				ctx,
			)
			results.push({
				...item,
				ok: true,
				warnings: saved.warnings,
			})
		} catch (error) {
			if (!(error instanceof McpCallerError)) throw error
			results.push({ ...item, ok: false, error: error.message })
		}
	}
	return operationResult({ ok: true as const, results })
}

async function resolveGrantTarget(
	db: D1Database,
	org: ManagedOrg,
	ref: OrgAccessSubjectRef,
): Promise<
	| { ok: true; subjectType: 'user' | 'team' | 'org'; subjectId: string }
	| { ok: false; error: string }
> {
	if (ref.kind === 'team') {
		const team = org.personal
			? null
			: await loadAccessTeam(db, org.id, ref.teamId)
		return team
			? { ok: true, subjectType: 'team', subjectId: team.id }
			: { ok: false, error: 'Team was not found in this organization.' }
	}
	if (ref.kind === 'org') {
		return org.personal
			? {
					ok: false,
					error: 'A personal account has no one else to give access to.',
				}
			: { ok: true, subjectType: 'org', subjectId: org.id }
	}
	const subject = await loadAccessSubject(db, org.id, ref.userId)
	if (!subject) {
		return {
			ok: false,
			error:
				'Choose a member or someone who already has access in this organization. Invite new people first.',
		}
	}
	if (subject.role === 'owner' || subject.role === 'admin') {
		return {
			ok: false,
			error: 'Owners and Admins already have full access to this organization.',
		}
	}
	return { ok: true, subjectType: 'user', subjectId: subject.userId }
}
