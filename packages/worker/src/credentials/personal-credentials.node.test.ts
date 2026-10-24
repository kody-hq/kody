import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import { findCredentialIdsByLegacyName } from './credential-ids.ts'
import {
	authorizePersonalCredentialUse,
	deletePersonalCredentialOrgGrantsForMember,
	grantPersonalCredentialToOrg,
	listPersonalCredentialCandidates,
	revokePersonalCredentialOrgGrant,
} from './personal-credentials.ts'

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

const now = '2026-10-11T00:00:00.000Z'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const people = Object.fromEntries(
		(['ann', 'bea', 'cy'] as const).map((username) => {
			const stableUserId = testStableUserIdFromEmail(`${username}@example.com`)
			return [
				username,
				{ stableUserId, personId: personIdFromStored(stableUserId) },
			]
		}),
	) as Record<
		'ann' | 'bea' | 'cy',
		{ stableUserId: string; personId: ReturnType<typeof personIdFromStored> }
	>
	for (const [username, person] of Object.entries(people)) {
		await db
			.prepare(
				`INSERT INTO users (username, email, password_hash, stable_user_id, personal_org_id)
				 VALUES (?, ?, 'x', ?, ?)`,
			)
			.bind(
				username,
				`${username}@example.com`,
				person.stableUserId,
				person.stableUserId,
			)
			.run()
		await provisionPersonalOrg(db, {
			stableUserId: person.stableUserId,
			username,
			createdAt: now,
		})
	}
	// Bea owns Acme; Ann is a member; Cy is not in it.
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: people.bea.personId,
			audit: createTestOrgAuditWriter(),
			slug: 'quillworks-co',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'quillworks-co'`)
		.first<{ id: string }>()
	const acmeId = ownerIdFromStored(acme!.id)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(acmeId, people.ann.stableUserId, now)
		.run()
	const annOrgId = personalOrgId(people.ann.personId)
	await saveSecret({
		env,
		userId: annOrgId,
		scope: 'user',
		name: 'annToken',
		value: 'ann-secret-value',
		audit: null,
	})
	const annTokenId = (
		await findCredentialIdsByLegacyName(db, annOrgId, {
			type: 'secret',
			name: 'annToken',
		})
	)[0]!
	return { db, env, people, acmeId, annOrgId, annTokenId }
}

test('a personal credential granted to an org is a candidate only for its owner', async () => {
	const t = await setup()
	const candidates = (
		actorPersonId: (typeof t.people)['ann']['personId'] | null,
	) =>
		listPersonalCredentialCandidates({
			db: t.db,
			actorPersonId,
			orgId: t.acmeId,
		})

	expect(await candidates(t.people.ann.personId)).toEqual([])
	await grantPersonalCredentialToOrg({
		db: t.db,
		ownerPersonId: t.people.ann.personId,
		credentialId: t.annTokenId,
		orgId: t.acmeId,
	})
	expect(await candidates(t.people.ann.personId)).toEqual([
		{
			id: t.annTokenId,
			kind: 'secret',
			name: 'annToken',
			live: true,
			ownerKind: 'user',
			ownerPersonId: t.people.ann.personId,
		},
	])
	// Acme's Owner, another org's person, and Automation (no person) never see it.
	expect(await candidates(t.people.bea.personId)).toEqual([])
	expect(await candidates(t.people.cy.personId)).toEqual([])
	expect(await candidates(null)).toEqual([])
	expect(
		await listPersonalCredentialCandidates({
			db: t.db,
			actorPersonId: t.people.ann.personId,
			orgId: t.annOrgId,
		}),
	).toEqual([])

	const authorizeAs = (
		actorPersonId: (typeof t.people)['ann']['personId'] | null,
	) =>
		authorizePersonalCredentialUse({
			db: t.db,
			actorPersonId,
			orgId: t.acmeId,
			credentialId: t.annTokenId,
		})
	await expect(authorizeAs(t.people.ann.personId)).resolves.toMatchObject({
		id: t.annTokenId,
	})
	for (const actor of [t.people.bea.personId, t.people.cy.personId, null]) {
		await expect(authorizeAs(actor)).rejects.toBeInstanceOf(AuthorizationError)
	}

	expect(
		await revokePersonalCredentialOrgGrant({
			db: t.db,
			ownerPersonId: t.people.ann.personId,
			credentialId: t.annTokenId,
			orgId: t.acmeId,
		}),
	).toBe(true)
	await expect(authorizeAs(t.people.ann.personId)).rejects.toBeInstanceOf(
		AuthorizationError,
	)
})

test('a grant needs the owner’s own live credential and a live binding to the org', async () => {
	const t = await setup()
	const grant = (input: {
		owner: (typeof t.people)['ann']['personId']
		credentialId?: string
		orgId?: ReturnType<typeof ownerIdFromStored>
	}) =>
		grantPersonalCredentialToOrg({
			db: t.db,
			ownerPersonId: input.owner,
			credentialId: input.credentialId ?? t.annTokenId,
			orgId: input.orgId ?? t.acmeId,
		})

	// Bea cannot grant Ann's credential, and Cy is not in Acme.
	await expect(grant({ owner: t.people.bea.personId })).rejects.toThrow(
		'No personal credential with that id',
	)
	await expect(
		grant({ owner: t.people.ann.personId, orgId: t.annOrgId }),
	).rejects.toThrow('already works in your personal org')
	await saveSecret({
		env: t.env,
		userId: personalOrgId(t.people.cy.personId),
		scope: 'user',
		name: 'cyToken',
		value: 'cy-secret-value',
		audit: null,
	})
	const cyTokenId = (
		await findCredentialIdsByLegacyName(
			t.db,
			personalOrgId(t.people.cy.personId),
			{ type: 'secret', name: 'cyToken' },
		)
	)[0]!
	await expect(
		grant({ owner: t.people.cy.personId, credentialId: cyTokenId }),
	).rejects.toThrow('an org you belong to')

	// Leaving the org deletes the grant; a live grant row alone is not enough.
	await grant({ owner: t.people.ann.personId })
	await t.db
		.prepare(
			`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ? AND user_id = ?`,
		)
		.bind(now, t.acmeId, t.people.ann.stableUserId)
		.run()
	expect(
		await listPersonalCredentialCandidates({
			db: t.db,
			actorPersonId: t.people.ann.personId,
			orgId: t.acmeId,
		}),
	).toEqual([])
	expect(
		await deletePersonalCredentialOrgGrantsForMember({
			db: t.db,
			orgId: t.acmeId,
			personId: t.people.ann.stableUserId,
		}),
	).toBe(1)
})

test('distinct personal org id still resolves personal credential grants', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const personStable = testStableUserIdFromEmail('dee@example.com')
	const personId = personIdFromStored(personStable)
	const distinctOrgId = ownerIdFromStored('e'.repeat(64))
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id, personal_org_id)
			 VALUES (1, 'dee', 'dee@example.com', 'x', ?, ?)`,
		)
		.bind(personStable, distinctOrgId)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId: personStable,
		orgId: distinctOrgId,
		username: 'dee',
		createdAt: now,
	})
	const beaStable = testStableUserIdFromEmail('bea-distinct@example.com')
	await db
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, stable_user_id, personal_org_id)
			 VALUES (2, 'beadistinct', 'bea-distinct@example.com', 'x', ?, ?)`,
		)
		.bind(beaStable, beaStable)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId: beaStable,
		username: 'beadistinct',
		createdAt: now,
	})
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: personIdFromStored(beaStable),
			audit: createTestOrgAuditWriter(),
			slug: 'distinct-acme',
			displayName: 'Distinct Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'distinct-acme'`)
		.first<{ id: string }>()
	const acmeId = ownerIdFromStored(acme!.id)
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(acmeId, personStable, now)
		.run()
	await saveSecret({
		env,
		userId: distinctOrgId,
		scope: 'user',
		name: 'deeToken',
		value: 'dee-secret-value',
		audit: null,
	})
	const tokenId = (
		await findCredentialIdsByLegacyName(db, distinctOrgId, {
			type: 'secret',
			name: 'deeToken',
		})
	)[0]!
	await grantPersonalCredentialToOrg({
		db,
		ownerPersonId: personId,
		credentialId: tokenId,
		orgId: acmeId,
	})
	expect(
		await listPersonalCredentialCandidates({
			db,
			actorPersonId: personId,
			orgId: acmeId,
		}),
	).toEqual([
		expect.objectContaining({
			id: tokenId,
			name: 'deeToken',
			ownerPersonId: personId,
		}),
	])
	await expect(
		grantPersonalCredentialToOrg({
			db,
			ownerPersonId: personId,
			credentialId: tokenId,
			orgId: distinctOrgId,
		}),
	).rejects.toThrow('already works in your personal org')
})

test('expired secrets, package secrets, and suspended personal orgs are not personal credentials', async () => {
	const t = await setup()
	const ann = t.people.ann.personId
	const later = new Date('2026-10-12T00:00:00.000Z')
	const candidateIds = async () =>
		(
			await listPersonalCredentialCandidates({
				db: t.db,
				actorPersonId: ann,
				orgId: t.acmeId,
				now: later,
			})
		).map((credential) => credential.id)
	await grantPersonalCredentialToOrg({
		db: t.db,
		ownerPersonId: ann,
		credentialId: t.annTokenId,
		orgId: t.acmeId,
		now: later,
	})
	expect(await candidateIds()).toEqual([t.annTokenId])

	await t.db
		.prepare(`UPDATE secret_entries SET expires_at = ? WHERE id = ?`)
		.bind(now, t.annTokenId)
		.run()
	expect(await candidateIds()).toEqual([])
	await t.db
		.prepare(`UPDATE secret_entries SET expires_at = NULL WHERE id = ?`)
		.bind(t.annTokenId)
		.run()
	await t.db
		.prepare(
			`UPDATE secret_buckets SET expires_at = ?
			WHERE id = (SELECT bucket_id FROM secret_entries WHERE id = ?)`,
		)
		.bind(now, t.annTokenId)
		.run()
	expect(await candidateIds()).toEqual([])
	await expect(
		authorizePersonalCredentialUse({
			db: t.db,
			actorPersonId: ann,
			orgId: t.acmeId,
			credentialId: t.annTokenId,
			now: later,
		}),
	).rejects.toBeInstanceOf(AuthorizationError)
	await t.db
		.prepare(
			`UPDATE secret_buckets SET expires_at = NULL
			WHERE id = (SELECT bucket_id FROM secret_entries WHERE id = ?)`,
		)
		.bind(t.annTokenId)
		.run()
	expect(await candidateIds()).toEqual([t.annTokenId])

	await saveSecret({
		env: t.env,
		userId: t.annOrgId,
		scope: 'package',
		name: 'annPackageToken',
		value: 'ann-package-secret-value',
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: 'ann-package',
			storageId: 'ann-package',
		},
		audit: null,
	})
	const packageTokenId = (
		await findCredentialIdsByLegacyName(t.db, t.annOrgId, {
			type: 'secret',
			name: 'annPackageToken',
		})
	)[0]!
	await expect(
		grantPersonalCredentialToOrg({
			db: t.db,
			ownerPersonId: ann,
			credentialId: packageTokenId,
			orgId: t.acmeId,
			now: later,
		}),
	).rejects.toThrow('No personal credential with that id')

	await t.db
		.prepare(`UPDATE orgs SET suspended_at = ? WHERE id = ?`)
		.bind(now, t.annOrgId)
		.run()
	expect(await candidateIds()).toEqual([])
})
