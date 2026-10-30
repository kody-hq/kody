import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import {
	contextGrantSubjects,
	type ExecutionContextRow,
	loadContextAccess,
} from '#worker/execution-contexts/store.ts'
import { outsideInviterGrantSubjects } from '#mcp/capabilities/access/invites.ts'
import { grantSubjectTypes } from '#worker/orgs/access-writes.ts'
import {
	grantOnlyBindingSubjects,
	listOrganizationsForPerson,
	listOrgsForPerson,
	loadLiveOrgBindingForOrg,
	loadOrgBindingForSlug,
} from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import {
	collaboratorPeople,
	collaboratorsNow,
	type CollaboratorPerson,
	insertCollaboratorGrant,
	type PackageCollaboratorsSeed,
	seedPackageCollaborators,
} from '#worker/test-support/package-collaborators-seed.ts'
import {
	bumpAccessEpochStatement,
	compileAccessForRequest,
	liveGrantRowSubjects,
} from './access-compile.ts'
import { type GrantSubjectChoices } from './grant-subjects.ts'

const workerSrc = fileURLToPath(new URL('../', import.meta.url))

/** Every lookup that asks "which grants reach this person", by file. */
const lookupSites: Record<string, GrantSubjectChoices> = {
	'authorization/access-compile.ts': liveGrantRowSubjects,
	'execution-contexts/store.ts': contextGrantSubjects,
	'orgs/repo.ts': grantOnlyBindingSubjects,
	'mcp/capabilities/access/invites.ts': outsideInviterGrantSubjects,
}

/**
 * Hand-written `subject_type` matches outside the helper. None of these ask
 * which grants reach a person, so they stay out of `grantSubjectMatchSql`.
 */
const handWrittenSubjectMatches: Record<
	string,
	{ count: number; reason: string }
> = {
	'orgs/access-writes.ts': {
		count: 2,
		reason:
			'Exact subject identity: upsert dedupe and the list filter bind one subject type.',
	},
	'orgs/offboarding.ts': {
		count: 1,
		reason: "Revokes the departing member's own user-subject rows.",
	},
	'orgs/creator-access.ts': {
		count: 1,
		reason:
			"Reads the creator's own user-subject row (live or revoked) to stay idempotent.",
	},
	'orgs/invite-link-redeem.ts': {
		count: 1,
		reason:
			"Reads the person's own direct grant row to merge the link preset into.",
	},
	'execution-contexts/service.ts': {
		count: 3,
		reason:
			'loadSharing joins user and team labels for display, after the grant rows are chosen.',
	},
	'orgs/repo.ts': {
		count: 2,
		reason:
			'listOrganizationsForPerson lists grant-only orgs across every org, driven from the person grants and seats; the parity test below pins it to liveGrantForPersonSql.',
	},
}

const subjectTypeMatchPattern =
	/\bsubject_type\s*(?:=(?!=)|!=(?!=)|<>|\bIN\s*\(|\bLIKE\b)/gi

function workerSourceFiles(dir = workerSrc): Array<string> {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) {
			return entry.name === 'test-support' ? [] : workerSourceFiles(path)
		}
		if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
			return []
		}
		return [relative(workerSrc, path).split('\\').join('/')]
	})
}

test('every grant subject lookup decides every subject type', () => {
	const decisions = Object.entries(lookupSites).map(([site, subjects]) => ({
		site,
		types: Object.keys(subjects).sort(),
		undocumentedExclusions: grantSubjectTypes.filter((type) => {
			const choice = subjects[type]
			return choice !== 'include' && !choice?.exclude.trim()
		}),
	}))
	expect(decisions).toEqual(
		Object.keys(lookupSites).map((site) => ({
			site,
			types: [...grantSubjectTypes].sort(),
			undocumentedExclusions: [],
		})),
	)
})

test('subject_type matching in worker SQL goes through grantSubjectMatchSql', () => {
	const helperCallers = new Set<string>()
	const handWritten: Record<string, number> = {}
	for (const file of workerSourceFiles()) {
		if (file === 'authorization/grant-subjects.ts') continue
		const source = readFileSync(join(workerSrc, file), 'utf8')
		if (source.includes('grantSubjectMatchSql(')) helperCallers.add(file)
		const matches = source.match(subjectTypeMatchPattern)?.length ?? 0
		if (matches > 0) handWritten[file] = matches
	}
	expect(
		[...helperCallers].sort(),
		'Add a new grantSubjectMatchSql caller to lookupSites',
	).toEqual(Object.keys(lookupSites).sort())
	expect(
		handWritten,
		'Use grantSubjectMatchSql to match grant subjects to a person',
	).toEqual(
		Object.fromEntries(
			Object.entries(handWrittenSubjectMatches).map(([file, entry]) => [
				file,
				entry.count,
			]),
		),
	)
})

async function seedWithContextTables() {
	const seed = await seedPackageCollaborators()
	seed.sqlite.exec(`
		CREATE TABLE execution_context_org_attachments (
			context_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			attached_by_user_id TEXT NOT NULL,
			all_members INTEGER NOT NULL DEFAULT 0,
			narrowing_json TEXT,
			created_at TEXT NOT NULL,
			PRIMARY KEY (context_id, org_id)
		);
		CREATE TABLE execution_context_opt_ins (
			context_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (context_id, user_id, org_id)
		);
	`)
	return seed
}

function insertGrant(
	seed: PackageCollaboratorsSeed,
	input: {
		id: string
		resourceType: string
		resourceId: string
		subjectType: string
		subjectId: string
		preset: string
		orgId?: string
	},
) {
	seed.sqlite
		.prepare(
			`INSERT INTO grants (
			   id, org_id, resource_type, resource_id, subject_type, subject_id,
			   preset, created_by_user_id, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			input.orgId ?? seed.orgId,
			input.resourceType,
			input.resourceId,
			input.subjectType,
			input.subjectId,
			input.preset,
			collaboratorPeople.ada.personId,
			collaboratorsNow,
			collaboratorsNow,
		)
}

async function packagePermissions(
	seed: PackageCollaboratorsSeed,
	person: CollaboratorPerson,
	role: OrgRole | null,
) {
	const request = deriveRequestContext({
		user: {
			userId: personIdFromStored(collaboratorPeople[person].personId),
			username: person,
		},
		source: { kind: 'session' },
		orgBinding: {
			org: { id: ownerIdFromStored(seed.orgId), slug: 'zeta-co' },
			role,
		},
	})
	const compiled = await compileAccessForRequest({ db: seed.db, request })
	return [...(compiled.resourcePermissions.get('package:pkg-1') ?? [])].sort()
}

test('user, team, and org subject grants all reach a person through compiled access', async () => {
	const userSeed = await seedPackageCollaborators()
	insertCollaboratorGrant(userSeed, {
		id: 'grant-user',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'use',
	})
	expect(await packagePermissions(userSeed, 'dan', null)).toContain(
		'package:execute',
	)
	expect(await packagePermissions(userSeed, 'bob', 'member')).toEqual([])

	const teamSeed = await seedPackageCollaborators()
	insertCollaboratorGrant(teamSeed, {
		id: 'grant-team',
		packageId: 'pkg-1',
		subjectType: 'team',
		subjectId: 'team-design',
		preset: 'use',
	})
	expect(await packagePermissions(teamSeed, 'bob', 'member')).toContain(
		'package:execute',
	)
	teamSeed.sqlite
		.prepare(`UPDATE teams SET deleted_at = ? WHERE id = 'team-design'`)
		.run(collaboratorsNow)
	await bumpAccessEpochStatement(teamSeed.db, teamSeed.orgId).run()
	expect(await packagePermissions(teamSeed, 'bob', 'member')).toEqual([])

	const orgSeed = await seedPackageCollaborators()
	insertCollaboratorGrant(orgSeed, {
		id: 'grant-org',
		packageId: 'pkg-1',
		subjectType: 'org',
		subjectId: orgSeed.orgId,
		preset: 'use',
	})
	expect(await packagePermissions(orgSeed, 'bob', 'member')).toContain(
		'package:execute',
	)
	expect(await packagePermissions(orgSeed, 'dan', null)).toEqual([])
})

test('a team grant reaches a person only through a team in the grant org', async () => {
	const seed = await seedPackageCollaborators()
	seed.sqlite
		.prepare(
			`INSERT INTO teams (id, org_id, slug, name, created_at, updated_at)
			 VALUES ('team-elsewhere', 'other-org', 'elsewhere', 'Elsewhere', ?, ?)`,
		)
		.run(collaboratorsNow, collaboratorsNow)
	seed.sqlite
		.prepare(
			`INSERT INTO team_members (team_id, user_id, created_at) VALUES ('team-elsewhere', ?, ?)`,
		)
		.run(collaboratorPeople.bob.personId, collaboratorsNow)
	insertCollaboratorGrant(seed, {
		id: 'grant-foreign-team',
		packageId: 'pkg-1',
		subjectType: 'team',
		subjectId: 'team-elsewhere',
		preset: 'use',
	})
	expect(await packagePermissions(seed, 'bob', 'member')).toEqual([])
	const contextSeed = await seedWithContextTables()
	contextSeed.sqlite
		.prepare(
			`INSERT INTO teams (id, org_id, slug, name, created_at, updated_at)
			 VALUES ('team-elsewhere', 'other-org', 'elsewhere', 'Elsewhere', ?, ?)`,
		)
		.run(collaboratorsNow, collaboratorsNow)
	contextSeed.sqlite
		.prepare(
			`INSERT INTO team_members (team_id, user_id, created_at) VALUES ('team-elsewhere', ?, ?)`,
		)
		.run(collaboratorPeople.bob.personId, collaboratorsNow)
	insertGrant(contextSeed, {
		id: 'grant-context-foreign-team',
		resourceType: 'execution_context',
		resourceId: 'ctx-1',
		subjectType: 'team',
		subjectId: 'team-elsewhere',
		preset: 'use',
	})
	expect((await contextAccess(contextSeed, 'bob')).preset).toBeNull()
})

function contextRow(seed: PackageCollaboratorsSeed): ExecutionContextRow {
	return {
		id: 'ctx-1',
		org_id: seed.orgId,
		operator_user_id: collaboratorPeople.ada.personId,
		all_members: 0,
		name: 'laptop',
		public_key_jwk: '{}',
		thumbprint: 'thumb',
		created_at: collaboratorsNow,
		revoked_at: null,
		revoked_reason: null,
		last_seen_at: null,
		client_name: null,
		client_version: null,
		capabilities_json: null,
		grant_json: null,
		grant_version: 1,
	}
}

function contextAccess(
	seed: PackageCollaboratorsSeed,
	person: CollaboratorPerson,
) {
	return loadContextAccess(seed.db, contextRow(seed), {
		userId: collaboratorPeople[person].personId,
		orgId: seed.orgId,
	})
}

test('context grants reach a person directly or through a team, never through an org subject', async () => {
	const seed = await seedWithContextTables()
	insertGrant(seed, {
		id: 'grant-context-org',
		resourceType: 'execution_context',
		resourceId: 'ctx-1',
		subjectType: 'org',
		subjectId: seed.orgId,
		preset: 'manage',
	})
	expect(await contextAccess(seed, 'bob')).toMatchObject({
		granted: false,
		preset: null,
		unusableReason: 'not_granted',
	})
	insertGrant(seed, {
		id: 'grant-context-team',
		resourceType: 'execution_context',
		resourceId: 'ctx-1',
		subjectType: 'team',
		subjectId: 'team-design',
		preset: 'use',
	})
	expect(await contextAccess(seed, 'bob')).toMatchObject({
		granted: true,
		preset: 'use',
	})
	insertGrant(seed, {
		id: 'grant-context-user',
		resourceType: 'execution_context',
		resourceId: 'ctx-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.bob.personId,
		preset: 'contribute',
	})
	expect(await contextAccess(seed, 'bob')).toMatchObject({
		granted: true,
		preset: 'contribute',
	})
})

async function grantOnlySlugs(seed: PackageCollaboratorsSeed) {
	const personId = collaboratorPeople.dan.personId
	const listed = (await listOrganizationsForPerson(seed.db, personId))
		.filter((org) => org.role === null)
		.map((org) => org.slug)
	const bound = (await listOrgsForPerson(seed.db, personId))
		.filter((org) => org.role === null)
		.map((org) => org.slug)
	expect(
		listed,
		'listOrganizationsForPerson matches listOrgsForPerson',
	).toEqual(bound)
	const bySlug = await loadOrgBindingForSlug(seed.db, personId, 'zeta-co')
	const byOrg = await loadLiveOrgBindingForOrg(seed.db, personId, seed.orgId)
	expect(Boolean(byOrg)).toBe(Boolean(bySlug))
	return { listed, bound: Boolean(bySlug) }
}

test('grant-only binding honors user and team grants, and an org subject grant never binds a non-member', async () => {
	const orgSeed = await seedPackageCollaborators()
	insertCollaboratorGrant(orgSeed, {
		id: 'grant-org',
		packageId: 'pkg-1',
		subjectType: 'org',
		subjectId: orgSeed.orgId,
		preset: 'use',
	})
	expect(await grantOnlySlugs(orgSeed)).toEqual({ listed: [], bound: false })

	const userSeed = await seedPackageCollaborators()
	insertCollaboratorGrant(userSeed, {
		id: 'grant-user',
		packageId: 'pkg-1',
		subjectType: 'user',
		subjectId: collaboratorPeople.dan.personId,
		preset: 'use',
	})
	expect(await grantOnlySlugs(userSeed)).toEqual({
		listed: ['zeta-co'],
		bound: true,
	})

	const teamSeed = await seedPackageCollaborators()
	teamSeed.sqlite
		.prepare(
			`INSERT INTO team_members (team_id, user_id, created_at) VALUES ('team-design', ?, ?)`,
		)
		.run(collaboratorPeople.dan.personId, collaboratorsNow)
	insertCollaboratorGrant(teamSeed, {
		id: 'grant-team',
		packageId: 'pkg-1',
		subjectType: 'team',
		subjectId: 'team-design',
		preset: 'use',
	})
	expect(await grantOnlySlugs(teamSeed)).toEqual({
		listed: ['zeta-co'],
		bound: true,
	})
	teamSeed.sqlite
		.prepare(`UPDATE teams SET deleted_at = ? WHERE id = 'team-design'`)
		.run(collaboratorsNow)
	expect(await grantOnlySlugs(teamSeed)).toEqual({ listed: [], bound: false })
})
