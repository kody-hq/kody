import { DatabaseSync } from 'node:sqlite'
import {
	type GrantPreset,
	resolveGrantPermissions,
} from '@kody-internal/shared/grant-presets.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

/**
 * `zeta-co` owned by ada with bob as a member and a `design` team (bob in
 * it). dan and erin are outsiders. `pkg-1` / `demo-package` and `pkg-2` /
 * `other-package` are org packages; `savedPackages` is what a mocked
 * `resolveSavedPackage` should return for them.
 */
export const collaboratorPeople = {
	ada: { id: 9, personId: 'a'.repeat(64) },
	bob: { id: 10, personId: 'b'.repeat(64) },
	dan: { id: 12, personId: 'd'.repeat(64) },
	erin: { id: 13, personId: 'e'.repeat(64) },
} as const

export type CollaboratorPerson = keyof typeof collaboratorPeople

export const collaboratorsNow = '2026-01-01T00:00:00.000Z'

export async function seedPackageCollaborators() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	await ensureUsersTestSchema({ db, columns: ['avatar_key'] })
	for (const [username, person] of Object.entries(collaboratorPeople)) {
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, stable_user_id, display_name)
				 VALUES (?, ?, ?, 'x', ?, ?)`,
			)
			.run(
				person.id,
				username,
				`${username}@example.com`,
				person.personId,
				username === 'bob' ? 'Bob Builder' : null,
			)
		await provisionPersonalOrg(db, {
			stableUserId: person.personId,
			username,
			createdAt: collaboratorsNow,
		})
	}
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: collaboratorPeople.ada.personId,
			audit: createTestOrgAuditWriter(),
			slug: 'zeta-co',
			displayName: 'Zeta Co',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const orgId = (await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'zeta-co'`)
		.first<{ id: string }>())!.id
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.run(orgId, collaboratorPeople.bob.personId, collaboratorsNow)
	sqlite
		.prepare(
			`INSERT INTO teams (id, org_id, slug, name, created_at, updated_at)
			 VALUES ('team-design', ?, 'design', 'Design', ?, ?)`,
		)
		.run(orgId, collaboratorsNow, collaboratorsNow)
	sqlite
		.prepare(
			`INSERT INTO team_members (team_id, user_id, created_at)
			 VALUES ('team-design', ?, ?)`,
		)
		.run(collaboratorPeople.bob.personId, collaboratorsNow)
	const savedPackages = [
		{ id: 'pkg-1', kodyId: 'demo-package', name: 'demo-package' },
		{ id: 'pkg-2', kodyId: 'other-package', name: 'other-package' },
	].map((savedPackage) => ({ ...savedPackage, userId: orgId }))
	return {
		sqlite,
		db,
		orgId,
		auditDb: createAuditTestDb(),
		savedPackages,
	}
}

export type PackageCollaboratorsSeed = Awaited<
	ReturnType<typeof seedPackageCollaborators>
>

export function insertCollaboratorGrant(
	seed: PackageCollaboratorsSeed,
	input: {
		id: string
		packageId: string
		subjectType: 'user' | 'team' | 'org'
		subjectId: string
		preset: GrantPreset
	},
) {
	seed.sqlite
		.prepare(
			`INSERT INTO grants (
			   id, org_id, resource_type, resource_id, subject_type, subject_id,
			   preset, created_by_user_id, created_at, updated_at
			 ) VALUES (?, ?, 'package', ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			seed.orgId,
			input.packageId,
			input.subjectType,
			input.subjectId,
			input.preset,
			collaboratorPeople.ada.personId,
			collaboratorsNow,
			collaboratorsNow,
		)
	for (const permission of resolveGrantPermissions({
		family: 'package',
		preset: input.preset,
		permissions: null,
	})) {
		seed.sqlite
			.prepare(
				`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
			)
			.run(input.id, permission)
	}
}

export function collaboratorCapabilityContext(
	seed: PackageCollaboratorsSeed,
	person: CollaboratorPerson,
	role: OrgRole | null,
) {
	const { personId } = collaboratorPeople[person]
	return {
		env: { APP_DB: seed.db, AUDIT_DB: seed.auditDb } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(personId),
				email: `${person}@example.com`,
				displayName: person,
				username: person,
			},
			orgBinding: {
				org: { id: ownerIdFromStored(seed.orgId), slug: 'zeta-co' },
				role,
			},
		}),
	}
}
