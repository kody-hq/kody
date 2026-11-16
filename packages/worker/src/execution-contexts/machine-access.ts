import {
	type GrantSubjectChoices,
	grantSubjectMatchSql,
} from '#worker/authorization/grant-subjects.ts'
import {
	parseAllowedPackages,
	stringifyAllowedPackages,
} from '#worker/mcp/secrets/allowed-packages.ts'
import { softDeleteGrant, upsertGrant } from '#worker/orgs/access-writes.ts'
import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'
import { grantResourceToProfile } from '#worker/profiles/package-grants.ts'
import { ExecutionContextError } from './errors.ts'
import {
	type MachineCapabilityRow,
	machineCapabilityUsePermission,
	networkCapabilityName,
} from './machine-capabilities.ts'
import {
	type ExecutionContextCaller,
	loadVisibleContext,
	recordContextAudit,
} from './service.ts'
import { canManageContext, parseGrant } from './store.ts'

/** The kinds that can be shared. The shell and host folders stay with the operator. */
export const shareableMachineCapabilityKinds = ['command', 'lan'] as const

type ShareableKind = (typeof shareableMachineCapabilityKinds)[number]

/** The kinds whose use the operator can limit to listed packages. */
export const packageLimitedMachineCapabilityKinds = [
	'shell',
	'command',
	'lan',
	'fs',
] as const

type PackageLimitedKind = (typeof packageLimitedMachineCapabilityKinds)[number]

export const maxMachineAccessPackages = 50

const kindWords = {
	shell: 'shell',
	command: 'command',
	lan: 'local network destination',
	fs: 'host folder',
} as const

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
				 WHERE context_id = ? AND removed_at IS NULL
				   AND (kind != 'shell' OR EXISTS (
					SELECT 1 FROM execution_contexts c
					WHERE c.id = machine_capabilities.context_id
					  AND json_extract(c.grant_json, '$.commands.enabled') = 1
				   ))
				   AND (kind != 'lan' OR name != '*' OR EXISTS (
					SELECT 1 FROM execution_contexts c
					WHERE c.id = machine_capabilities.context_id
					  AND json_extract(c.grant_json, '$.egress.mode') = 'public-and-lan'
				   ))
				 ORDER BY kind, name`,
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
	const packageNames = manages
		? await loadPackageNames(
				db,
				caller.orgId,
				capabilities.results.flatMap((capability) =>
					parseAllowedPackages(capability.allowed_packages_json),
				),
			)
		: new Map<string, string>()
	const entries = capabilities.results.map((capability) => ({
		id: capability.id,
		kind: capability.kind,
		name: capability.name,
		description: capability.description,
		shareable:
			isShareable(capability.kind) && capability.name !== networkCapabilityName,
		// Empty: code that is not a saved package, and packages the operator's
		// org wrote or adopted. Otherwise only these, and no ad hoc code.
		...(manages
			? {
					allowedPackages: parseAllowedPackages(
						capability.allowed_packages_json,
					).map((id) => ({ id, name: packageNames.get(id) ?? id })),
				}
			: {}),
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
	// Without Manage, a person's view is their own profiles' grants, not
	// everything the machine defines.
	return manages ? entries : entries.filter((entry) => entry.grants.length > 0)
}

/**
 * Names for the listed packages the caller's org owns. A package from another
 * org stays an id: a list entry is not access to that package.
 */
async function loadPackageNames(
	db: D1Database,
	orgId: string,
	ids: Array<string>,
) {
	const names = new Map<string, string>()
	await Promise.all(
		[...new Set(ids)].map(async (id) => {
			const saved = await getSavedPackageByIdInAnyOrg(db, id)
			if (saved?.userId === orgId) names.set(id, saved.name)
		}),
	)
	return names
}

async function missingPackages(db: D1Database, ids: Array<string>) {
	const found = await Promise.all(
		ids.map((id) => getSavedPackageByIdInAnyOrg(db, id)),
	)
	return ids.filter((_, index) => found[index] === null)
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

/**
 * The context plus whether the caller manages its machine access. Someone
 * who neither manages it nor has it shared with them learns nothing about
 * what the machine defines.
 */
async function loadMachineAccessContext(
	caller: ExecutionContextCaller,
	ref: string,
	scope: MachineAccessScope,
) {
	const { row, access } = await loadVisibleContext(caller, ref)
	const role = caller.request.membership?.role
	const manages =
		!scope.withoutManageAccess &&
		(canManageContext(access) || role === 'owner' || role === 'admin')
	if (!manages && !access.granted) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message: `${row.name} is not shared with you.`,
		})
	}
	return { row, access, manages }
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
	const { row, access, manages } = await loadMachineAccessContext(
		caller,
		ref,
		scope,
	)
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
	const { row, access, manages } = await loadMachineAccessContext(
		caller,
		ref,
		scope,
	)
	const { subject } = input
	if (!isShareable(input.kind) || input.name === networkCapabilityName) {
		throw new ExecutionContextError({
			status: 400,
			code: 'invalid_request',
			message:
				'Only named commands and local network destinations can be shared. The unrestricted shell, the whole local network and host folders cannot.',
		})
	}
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
	const { row, access, manages } = await loadMachineAccessContext(
		caller,
		ref,
		scope,
	)
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

/**
 * Limit one named command, local network destination or host folder to
 * listed packages, or lift the limit with an empty list. Operator only: the
 * list decides which code may act on their machine.
 */
export async function setMachineAccessPackages(
	caller: ExecutionContextCaller,
	ref: string,
	input: { kind: PackageLimitedKind; name: string; packageIds: Array<string> },
) {
	const { row, access, manages } = await loadMachineAccessContext(
		caller,
		ref,
		{},
	)
	if (!(manages && access.isOperator)) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message: `Only ${row.name}'s operator can choose which packages use its machine access.`,
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
	if (
		capability?.kind === 'shell' &&
		parseGrant(row).commands?.enabled !== true
	) {
		throw new ExecutionContextError({
			status: 403,
			code: 'execution_context_commands_off',
			message: `Host commands are off on ${row.name}, so there is no shell to limit. Its owner turns them on from that machine with \`kody context commands on\`.`,
		})
	}
	if (
		input.kind === 'lan' &&
		input.name === networkCapabilityName &&
		(!capability || parseGrant(row).egress.mode !== 'public-and-lan')
	) {
		throw new ExecutionContextError({
			status: capability ? 403 : 404,
			code: 'machine_capability_off',
			message: `The local network is off on ${row.name}, so there is nothing to limit. Its owner turns it on from that machine with \`kody context grant lan on\`. The entry is kind "lan", name "*".`,
		})
	}
	if (
		input.kind === 'lan' &&
		input.name === networkCapabilityName &&
		input.packageIds.length > 0
	) {
		// Machines do not ask Kody before using the whole local network yet, so a
		// list here would look like a limit and limit nothing.
		throw new ExecutionContextError({
			status: 400,
			code: 'invalid_request',
			message: `Machines do not check a package list for the whole local network yet, so Kody will not save one for ${row.name}. Limit a named local network destination instead.`,
		})
	}
	if (!capability && input.kind === 'shell') {
		throw new ExecutionContextError({
			status: 404,
			code: 'machine_capability_off',
			message: `${row.name} has never had host commands turned on, so it has no shell to limit. The shell's name is "shell".`,
		})
	}
	if (!capability) {
		throw new ExecutionContextError({
			status: 404,
			code: 'machine_capability_off',
			message: `${row.name} defines no ${kindWords[input.kind]} named "${input.name}". executionContextMachineAccessList shows what it defines.`,
		})
	}
	if (input.packageIds.some((id) => id.trim() === '')) {
		throw new ExecutionContextError({
			status: 400,
			code: 'invalid_request',
			message:
				'A package id cannot be blank. Pass [] to lift the package limit.',
		})
	}
	const before = parseAllowedPackages(capability.allowed_packages_json)
	const after = parseAllowedPackages(stringifyAllowedPackages(input.packageIds))
	if (after.length > maxMachineAccessPackages) {
		throw new ExecutionContextError({
			status: 400,
			code: 'invalid_request',
			message: `A machine access entry lists at most ${maxMachineAccessPackages} packages.`,
		})
	}
	const added = after.filter((id) => !before.includes(id))
	const unknown = await missingPackages(db, added)
	if (unknown.length > 0) {
		throw new ExecutionContextError({
			status: 400,
			code: 'invalid_request',
			message: `No saved package has the id ${unknown.join(', ')}. Pass package ids (packageGet returns one as package_id).`,
		})
	}
	const removed = before.filter((id) => !after.includes(id))
	if (added.length > 0 || removed.length > 0) {
		await db
			.prepare(
				`UPDATE machine_capabilities SET allowed_packages_json = ?, updated_at = ?
				 WHERE id = ? AND removed_at IS NULL`,
			)
			.bind(JSON.stringify(after), new Date().toISOString(), capability.id)
			.run()
		await recordContextAudit(
			caller,
			row.id,
			'machine_access_packages_changed',
			{
				capability: capability.name,
				capabilityId: capability.id,
				kind: capability.kind,
				added,
				removed,
			},
		)
	}
	return {
		id: row.id,
		canGrant: true,
		capabilities: await loadMachineAccess(caller, row.id, manages),
	}
}
