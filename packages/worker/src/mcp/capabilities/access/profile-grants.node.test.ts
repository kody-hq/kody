/**
 * accessGrant / accessList / accessRevoke with subject_type profile: an
 * existing agent profile gets a grant with the checks profileCreate uses.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { OrgRole } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { createMcpCallerContext } from '#mcp/context.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { profileCreateCapability } from '../profiles/capabilities.ts'
import { secretListCapability } from '../secrets/secret-list.ts'
import {
	accessGrantCapability,
	accessListCapability,
	accessRevokeCapability,
} from './access-grants.ts'

const now = '2026-10-10T00:00:00.000Z'

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	sqlite.exec(
		`INSERT INTO feature_flags (key, enabled, updated_by) VALUES ('profiles', 1, NULL)`,
	)
	const db = createD1FromSqlite(sqlite)
	const ownerId = testStableUserIdFromEmail('owner@example.com')
	const memberId = testStableUserIdFromEmail('member@example.com')
	const guestId = testStableUserIdFromEmail('guest@example.com')
	for (const [index, [stableUserId, username]] of [
		[ownerId, 'owneruser'],
		[memberId, 'memberuser'],
		[guestId, 'guestuser'],
	].entries()) {
		await db
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, created_at, updated_at, stable_user_id)
				 VALUES (?, ?, ?, 'h', ?, ?, ?)`,
			)
			.bind(
				index + 1,
				username,
				`${username}@example.com`,
				now,
				now,
				stableUserId,
			)
			.run()
		await provisionPersonalOrg(db, {
			stableUserId: stableUserId!,
			username: username!,
			createdAt: now,
		})
	}
	await db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
		.bind(ownerId, memberId, now)
		.run()
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const orgId = ownerIdFromStored(ownerId)
	await saveSecret({
		env,
		userId: orgId,
		scope: 'user',
		name: 'apiKey',
		value: 'secret-value',
		audit: null,
	})
	const ctx = (
		userId: string,
		username: string,
		role: OrgRole | null,
		org = { id: ownerId, slug: 'owneruser' },
	) => ({
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(userId),
				email: `${username}@example.com`,
				displayName: username,
				username,
			},
			orgBinding: {
				org: { id: ownerIdFromStored(org.id), slug: org.slug },
				role,
			},
		}),
	})
	const owner = ctx(ownerId, 'owneruser', 'owner')
	const listed = await secretListCapability.handler({ scope: 'user' }, owner)
	const credentialId = listed.secrets.find(
		(secret) => secret.name === 'apiKey',
	)?.credential_id
	if (!credentialId) throw new Error('secretList returned no credential id.')
	return {
		env,
		db,
		orgId,
		ownerId,
		memberId,
		guestId,
		ctx,
		owner,
		credentialId,
	}
}

async function createProfile(
	ctx: Awaited<ReturnType<typeof setup>>['owner'],
	name: string,
	parentProfileId?: string,
) {
	const profile = profileIdSchema.parse(
		await profileCreateCapability.handler(
			{
				name,
				...(parentProfileId ? { parent_profile_id: parentProfileId } : {}),
			},
			ctx,
		),
	)
	return profile.id
}

const profileIdSchema = z.object({ id: z.string() })

test('accessGrant gives an existing profile a credential, and accessList and accessRevoke see it', async () => {
	const { owner, credentialId } = await setup()
	const profileId = await createProfile(owner, 'release-bot')
	const { grant } = await accessGrantCapability.handler(
		{
			resource_type: 'credential',
			resource_id: credentialId,
			subject_type: 'profile',
			subject_id: profileId,
			preset: 'use',
		},
		owner,
	)
	expect(grant).toMatchObject({
		resource_type: 'credential',
		resource_id: credentialId,
		subject_type: 'profile',
		subject_id: profileId,
		permissions: ['secret:use'],
	})
	const listed = await accessListCapability.handler(
		{ subject_type: 'profile', subject_id: profileId },
		owner,
	)
	expect(listed.grants).toEqual([grant])
	// Person grants stay listed without profile grants.
	const people = await accessListCapability.handler(
		{ resource_type: 'credential', resource_id: credentialId },
		owner,
	)
	expect(people.grants.some((row) => row.id === grant.id)).toBe(false)
	await expect(
		accessRevokeCapability.handler({ grant_id: grant.id }, owner),
	).resolves.toEqual({ grant_id: grant.id, revoked: true })
	const after = await accessListCapability.handler(
		{ subject_type: 'profile', subject_id: profileId },
		owner,
	)
	expect(after.grants).toEqual([])
})

test('a profile grant needs the caller to hold each permission, the profile to be theirs, and every parent to hold it', async () => {
	const { owner, ctx, memberId, credentialId } = await setup()
	const member = ctx(memberId, 'memberuser', 'member')
	const ownersProfile = await createProfile(owner, 'owner-bot')
	const membersProfile = await createProfile(member, 'member-bot')
	const grantTo = (subjectId: string, caller = owner) =>
		accessGrantCapability.handler(
			{
				resource_type: 'credential',
				resource_id: credentialId,
				subject_type: 'profile',
				subject_id: subjectId,
				permissions: ['secret:use'],
			},
			caller,
		)
	await expect(grantTo(membersProfile, member)).rejects.toMatchObject({
		code: 'profile_grant_exceeds_caller',
	})
	await expect(grantTo(ownersProfile, member)).rejects.toMatchObject({
		code: 'not_allowed',
	})
	const child = await createProfile(owner, 'helper', ownersProfile)
	await expect(grantTo(child)).rejects.toMatchObject({
		code: 'profile_grant_exceeds_parent',
	})
	await grantTo(ownersProfile)
	await expect(grantTo(child)).resolves.toMatchObject({
		grant: { subject_id: child },
	})
	const { grants } = await accessListCapability.handler(
		{ subject_type: 'profile', subject_id: ownersProfile },
		owner,
	)
	await expect(
		accessRevokeCapability.handler({ grant_id: grants[0]!.id }, member),
	).rejects.toMatchObject({ code: 'not_allowed' })
	await expect(
		accessGrantCapability.handler(
			{
				resource_type: 'credential',
				resource_id: credentialId,
				subject_type: 'profile',
				subject_id: ownersProfile,
				preset: 'use',
				expires_at: '2099-01-01T00:00:00Z',
			},
			owner,
		),
	).rejects.toThrow('A profile grant has no expiry of its own.')
})
