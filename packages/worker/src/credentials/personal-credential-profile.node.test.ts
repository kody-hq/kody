import { DatabaseSync } from 'node:sqlite'
import type { OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import type * as AuthorizeModule from '#worker/authorization/authorize.ts'
import type {
	ProfileChainAccess,
	ProfileChainLayer,
} from '#worker/authorization/authorize.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import { findCredentialIdsByLegacyName } from './credential-ids.ts'
import { authorizeActorPersonalUse } from './credential-resolver.ts'
import { grantPersonalCredentialToOrg } from './personal-credentials.ts'

const chains = vi.hoisted(() => new Map<string, ProfileChainAccess>())

// Person access for granted personal credentials is the owner grant; only the
// profile chain comes from the compiled permissions.
vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuthorizeModule>()
	return {
		...actual,
		computeEffectivePermissions: async ({
			request,
		}: {
			request: RequestContext
		}) => ({
			orgId: request.org.id,
			permissions: new Set(),
			isOwner: false,
			resourcePermissions: new Map(),
			credentialScopes: null,
			profileChain: request.credential.profileId
				? (chains.get(request.credential.profileId) ?? null)
				: null,
		}),
	}
})

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

const now = '2026-11-04T00:00:00.000Z'

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
		(['ann', 'bea'] as const).map((username) => {
			const stableUserId = testStableUserIdFromEmail(`${username}@example.com`)
			return [
				username,
				{ stableUserId, personId: personIdFromStored(stableUserId) },
			]
		}),
	) as Record<'ann' | 'bea', { stableUserId: string; personId: PersonId }>
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
		name: 'notes-key',
		value: 'ann-secret-value',
		audit: null,
	})
	const credentialId = (
		await findCredentialIdsByLegacyName(db, annOrgId, {
			type: 'secret',
			name: 'notes-key',
		})
	)[0]!
	await grantPersonalCredentialToOrg({
		db,
		ownerPersonId: people.ann.personId,
		credentialId,
		orgId: acmeId,
	})
	return { env, people, acmeId, credentialId }
}

function layer(
	name: string,
	self: boolean,
	grants: Record<string, Array<OrgPermission>>,
): ProfileChainLayer {
	return {
		id: `prf_${name}`,
		name,
		self,
		orgPermissions: new Set(),
		resourcePermissions: new Map(
			Object.entries(grants).map(([key, list]) => [key, new Set(list)]),
		),
	}
}

test('a granted personal credential by name needs every profile layer, like the credential list', async () => {
	const t = await setup()
	const granted = { [`credential:${t.credentialId}`]: ['secret:use' as const] }
	chains.set('prf_granted', {
		inactive: null,
		layers: [layer('helper', true, granted), layer('agent', false, granted)],
	})
	chains.set('prf_ungranted', {
		inactive: null,
		layers: [layer('helper', true, {}), layer('agent', false, granted)],
	})
	chains.set('prf_parent_ungranted', {
		inactive: null,
		layers: [layer('helper', true, granted), layer('agent', false, {})],
	})
	chains.set('prf_inactive', {
		inactive: {
			id: 'prf_inactive',
			name: 'helper',
			self: true,
			reason: 'revoked',
		},
		layers: [layer('helper', true, granted)],
	})
	const useAs = (input: {
		person?: 'ann' | 'bea'
		scopes?: Array<OrgPermission> | null
		profileId?: string | null
	}) =>
		authorizeActorPersonalUse({
			env: t.env,
			actor: {
				org: { id: t.acmeId },
				actor: { userId: t.people[input.person ?? 'ann'].personId },
				credential: {
					kind: 'token',
					id: 'tok',
					scopes: input.scopes ?? null,
					profileId: input.profileId ?? null,
				},
				membership: { role: 'member' },
			} as unknown as RequestContext,
			orgId: t.acmeId,
			credentialId: t.credentialId,
			name: 'notes-key',
			permission: 'secret:use',
		})

	// Owner without a profile, and a chain where every layer has Use.
	await expect(useAs({})).resolves.toBeUndefined()
	await expect(useAs({ scopes: ['secret:use'] })).resolves.toBeUndefined()
	await expect(useAs({ profileId: 'prf_granted' })).resolves.toBeUndefined()
	await expect(
		useAs({ profileId: 'prf_granted', scopes: ['secret:use'] }),
	).resolves.toBeUndefined()

	await expect(useAs({ scopes: ['package:read'] })).rejects.toMatchObject({
		code: 'credential_scope',
	})
	await expect(useAs({ person: 'bea' })).rejects.toMatchObject({
		code: 'missing_permission',
	})
	await expect(
		useAs({ person: 'bea', profileId: 'prf_granted' }),
	).rejects.toMatchObject({ code: 'missing_permission' })
	await expect(
		useAs({ profileId: 'prf_granted', scopes: ['package:read'] }),
	).rejects.toMatchObject({ code: 'credential_scope' })

	await expect(useAs({ profileId: 'prf_ungranted' })).rejects.toMatchObject({
		code: 'profile_grant',
		message: expect.stringContaining('Profile "helper"'),
	})
	await expect(
		useAs({ profileId: 'prf_parent_ungranted' }),
	).rejects.toMatchObject({
		code: 'profile_grant',
		message: expect.stringContaining('Parent profile "agent"'),
	})
	await expect(useAs({ profileId: 'prf_inactive' })).rejects.toMatchObject({
		code: 'profile_inactive',
	})
})
