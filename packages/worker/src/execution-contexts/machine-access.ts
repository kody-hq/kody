import {
	type GrantSubjectChoices,
	grantSubjectMatchSql,
} from '#worker/authorization/grant-subjects.ts'
import { softDeleteGrant, upsertGrant } from '#worker/orgs/access-writes.ts'
import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import { grantResourceToProfile } from '#worker/profiles/package-grants.ts'
import { ExecutionContextError } from './errors.ts'
import {
	type MachineCapabilityRow,
	machineCapabilityUsePermission,
} from './machine-capabilities.ts'
import {
	type ExecutionContextCaller,
	loadVisibleContext,
	recordContextAudit,
} from './service.ts'
import { canManageContext } from './store.ts'

/** The kinds that can be shared. The shell and host folders stay with the operator. */
export const shareableMachineCapabilityKinds = ['command', 'lan'] as const

type ShareableKind = (typeof shareableMachineCapabilityKinds)[number]

/** A machine access grant reaches a person directly, through a team, or as a member of the org. */
// A profile's grant is checked as a layer of its chain (checkProfileChain), not here.
export const machineAccessGrantSubjects = {
	user: 'include',
	team: 'include',
	org: 'include',
	profile: {
		exclude:
			'Profile grants narrow a profile; they never grant the person behind it.',
	},
} as const satisfies GrantSubjectChoices

/** Whether a live grant in `orgId` gives `userId` Use of the capability. */
export async function hasMachineAccessGrant(
	db: D1Database,
	input: { capabilityId: string; userId: string; orgId: string },
) {
	const match = grantSubjectMatchSql({
		subjects: machineAccessGrantSubjects,
		personId: input.userId,
		boundOrgId: input.orgId,
	})
	const row = await db
		.prepare(
			`SELECT 1 AS ok FROM grants g
			 WHERE g.resource_type = 'machine_capability' AND g.resource_id = ?
			   AND g.org_id = ? AND g.deleted_at IS NULL
			   AND EXISTS (
				SELECT 1 FROM grant_permissions gp
				WHERE gp.grant_id = g.id AND gp.permission = '${machineCapabilityUsePermission}'
			   )
			   AND ${match.sql}
			 LIMIT 1`,
		)
		.bind(input.capabilityId, input.orgId, ...match.binds)
		.first()
	return row !== null
}

type GrantRow = {
	id: string
	resource_id: string
	subject_type: 'user' | 'team' | 'org' | 'profile'
	subject_id: string
	username: string | null
	team_slug: string | null
	profile_name: string | null
	profile_acting_user_id: string | null
}

async function loadMachineAccess(
	caller: ExecutionContextCaller,
	contextId: string,
	manages: boolean,
) {
	const db = caller.env.APP_DB
	const [capabilities, grants] = await Promise.all([
		db
			.prepare(
				`SELECT * FROM machine_capabilities
				 WHERE context_id = ? AND removed_at IS NULL ORDER BY kind, name`,
			)
			.bind(contextId)
			.all<MachineCapabilityRow>(),
		db
			.prepare(
				`SELECT g.id, g.resource_id, g.subject_type, g.subject_id, u.username,
					t.slug AS team_slug, p.name AS profile_name,
					p.acting_user_id AS profile_acting_user_id
				 FROM grants g
				 LEFT JOIN users u ON g.subject_type = 'user' AND u.stable_user_id = g.subject_id
				 LEFT JOIN teams t ON g.subject_type = 'team' AND t.id = g.subject_id
					AND t.org_id = g.org_id AND t.deleted_at IS NULL
				 LEFT JOIN profiles p ON g.subject_type = 'profile' AND p.id = g.subject_id
					AND p.org_id = g.org_id AND p.revoked_at IS NULL
				 WHERE g.resource_type = 'machine_capability' AND g.org_id = ?
				   AND g.deleted_at IS NULL
				   AND (g.expires_at IS NULL OR g.expires_at > ?)
				   AND g.resource_id IN (
					SELECT id FROM machine_capabilities WHERE context_id = ?
				   )
				 ORDER BY g.created_at`,
			)
			.bind(caller.orgId, new Date().toISOString(), contextId)
			.all<GrantRow>(),
	])
	return capabilities.results.map((capability) => ({
		id: capability.id,
		kind: capability.kind,
		name: capability.name,
		description: capability.description,
		shareable: isShareable(capability.kind),
		grants: grants.results
			.filter(
				(grant) =>
					grant.resource_id === capability.id &&
					// Someone who does not manage the machine sees only what they
					// gave their own profiles.
					(manages || grant.profile_acting_user_id === caller.userId),
			)
			.flatMap((grant) => {
				const subject =
					grant.subject_type === 'org'
						? ({ kind: 'everyone' } as const)
						: grant.subject_type === 'team'
							? grant.team_slug
								? ({ kind: 'team', slug: grant.team_slug } as const)
								: null
							: grant.subject_type === 'profile'
								? grant.profile_name
									? ({
											kind: 'profile',
											id: grant.subject_id,
											name: grant.profile_name,
										} as const)
									: null
								: grant.username
									? ({ kind: 'user', handle: grant.username } as const)
									: null
				return subject ? [{ grantId: grant.id, subject }] : []
			}),
	}))
}

function isShareable(kind: string): kind is ShareableKind {
	return (shareableMachineCapabilityKinds as ReadonlyArray<string>).includes(
		kind,
	)
}

/**
 * What a caller whose credential lacks `execution_context:manage_access`
 * may still do: give their own profiles what they can use, and take it back.
 */
export type MachineAccessScope = { withoutManageAccess?: true }

function managesMachineAccess(
	caller: ExecutionContextCaller,
	access: Parameters<typeof canManageContext>[0],
	scope: MachineAccessScope,
) {
	const role = caller.request.membership?.role
	return (
		!scope.withoutManageAccess &&
		(canManageContext(access) || role === 'owner' || role === 'admin')
	)
}

/**
 * The operator, Manage holders and org owners see every grant. Anyone else
 * who can see the context sees only the grants on their own profiles.
 */
export async function listMachineAccess(
	caller: ExecutionContextCaller,
	ref: string,
	scope: MachineAccessScope = {},
) {
	const { row, access } = await loadVisibleContext(caller, ref)
	const manages = managesMachineAccess(caller, access, scope)
	return {
		id: row.id,
		canGrant: manages && access.isOperator,
		capabilities: await loadMachineAccess(caller, row.id, manages),
	}
}

/**
 * Share one named command or local network destination. Only the operator
 * grants: the machine is theirs, and a grant lets someone else's run act on
 * it. The person still needs the context shared with them to run there.
 */
export async function grantMachineAccess(
	caller: ExecutionContextCaller,
	ref: string,
	input: {
		kind: ShareableKind
		name: string
		subject:
			| { type: 'user' | 'team' | 'org'; id: string }
			| { type: 'profile'; id: string }
	},
	scope: MachineAccessScope = {},
) {
	const { row, access } = await loadVisibleContext(caller, ref)
	const { subject } = input
	const manages = managesMachineAccess(caller, access, scope)
	if (subject.type !== 'profile' && !(manages && access.isOperator)) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message: `Only ${row.name}'s operator can share its named commands and local network destinations.`,
		})
	}
	if (subject.type === 'user' && subject.id === caller.userId) {
		throw new ExecutionContextError({
			status: 400,
			code: 'invalid_request',
			message: `You operate ${row.name}, so you already have its machine access.`,
		})
	}
	const db = caller.env.APP_DB
	const capability = await db
		.prepare(
			`SELECT * FROM machine_capabilities
			 WHERE context_id = ? AND kind = ? AND name = ? AND removed_at IS NULL`,
		)
		.bind(row.id, input.kind, input.name)
		.first<MachineCapabilityRow>()
	if (!capability) {
		throw new ExecutionContextError({
			status: 404,
			code: 'machine_capability_off',
			message: `${row.name} defines no ${input.kind === 'lan' ? 'local network destination' : 'command'} named "${input.name}". \`kody context capability list\` on that machine shows what it defines.`,
		})
	}
	if (subject.type === 'profile') {
		// A profile only narrows the person it acts for, so that person gives
		// it what they hold themselves: the operator's own access, or a grant.
		if (
			!access.isOperator &&
			!(await hasMachineAccessGrant(db, {
				capabilityId: capability.id,
				userId: caller.userId,
				orgId: caller.orgId,
			}))
		) {
			throw new ExecutionContextError({
				status: 403,
				code: 'machine_capability_not_granted',
				message: `You are not granted "${capability.name}" on ${row.name}, so your profile cannot get it. The machine's operator can share it with you first.`,
			})
		}
		await grantResourceToProfile({
			env: caller.env,
			request: caller.request,
			profileId: subject.id,
			resource: {
				type: 'machine_capability',
				id: capability.id,
				label: `"${capability.name}" on ${row.name}`,
			},
			preset: null,
			permissions: [machineCapabilityUsePermission],
			ifParentLacks: 'Give the parent profile this machine access first.',
		})
	} else {
		await upsertGrant({
			db,
			orgId: caller.orgId,
			resourceType: 'machine_capability',
			resourceId: capability.id,
			subject,
			preset: null,
			permissions: [machineCapabilityUsePermission],
			createdByUserId: caller.userId,
			audit: orgAuditWriterFromCaller(caller.env, caller.callerContext),
		})
	}
	await recordContextAudit(caller, row.id, 'machine_access_granted', {
		capability: capability.name,
		capabilityId: capability.id,
		kind: capability.kind,
		subject,
	})
	return {
		id: row.id,
		canGrant: manages && access.isOperator,
		capabilities: await loadMachineAccess(caller, row.id, manages),
	}
}

/** Take a grant back. Each use is checked, so it stops on the next call. */
export async function revokeMachineAccess(
	caller: ExecutionContextCaller,
	ref: string,
	grantId: string,
	scope: MachineAccessScope = {},
) {
	const { row, access } = await loadVisibleContext(caller, ref)
	const manages = managesMachineAccess(caller, access, scope)
	const db = caller.env.APP_DB
	const grant = await db
		.prepare(
			`SELECT g.id, c.id AS capability_id, c.name, c.kind,
				p.acting_user_id AS profile_acting_user_id
			 FROM grants g
			 INNER JOIN machine_capabilities c ON c.id = g.resource_id AND c.context_id = ?
			 LEFT JOIN profiles p ON g.subject_type = 'profile' AND p.id = g.subject_id
				AND p.org_id = g.org_id
			 WHERE g.id = ? AND g.org_id = ? AND g.resource_type = 'machine_capability'
			   AND g.deleted_at IS NULL`,
		)
		.bind(row.id, grantId, caller.orgId)
		.first<{
			id: string
			capability_id: string
			name: string
			kind: string
			profile_acting_user_id: string | null
		}>()
	// A person takes back what they gave their own profile; everything else
	// needs the operator, Manage, or an org owner.
	if (!grant || (!manages && grant.profile_acting_user_id !== caller.userId)) {
		throw new ExecutionContextError({
			status: 404,
			code: 'not_found',
			message: `${row.name} has no machine access grant with that id in this org.`,
		})
	}
	await softDeleteGrant({
		db,
		orgId: caller.orgId,
		grantId,
		audit: orgAuditWriterFromCaller(caller.env, caller.callerContext),
	})
	await recordContextAudit(caller, row.id, 'machine_access_revoked', {
		capability: grant.name,
		capabilityId: grant.capability_id,
		kind: grant.kind,
		grantId,
	})
	return {
		id: row.id,
		canGrant: manages && access.isOperator,
		capabilities: await loadMachineAccess(caller, row.id, manages),
	}
}
