import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	packageOwnerEntitlementEmail,
	resolvePackageOwnerContext,
} from './package-owner.ts'

function personUsername() {
	return `person-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
}

async function seedPersonUser(input: { username: string; email: string }) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
		 VALUES (?, ?, 'test-password-hash', ?, ?)`,
	)
		.bind(input.username, input.email, new Date().toISOString(), stableUserId)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId,
		username: input.username,
		plan: 'max',
	})
	return { username: input.username, email: input.email, stableUserId }
}

function orgBoundRequest(
	request: RequestContext,
	org: RequestContext['org'],
): RequestContext {
	return {
		...request,
		org,
		credential: { ...request.credential, orgId: org.id },
		membership: { role: 'member' },
	}
}

test('resolvePackageOwnerContext owns packages in the org the request is bound to', async () => {
	await ensureUsersTestSchema({
		db: env.APP_DB,
		columns: ['email_verified_at'],
	})
	const person = await seedPersonUser({
		username: personUsername(),
		email: `owner-${crypto.randomUUID()}@example.com`,
	})
	const user = {
		userId: personIdFromStored(person.stableUserId),
		email: person.email,
		displayName: person.username,
	}
	const personalRequest = sessionRequestContext(person.stableUserId)

	expect(
		await resolvePackageOwnerContext(env, { user, request: personalRequest }),
	).toEqual({
		ownerUserId: person.stableUserId,
		ownerScope: person.username,
		ownerEmail: person.email,
		actorUserId: person.stableUserId,
		actorPersonalOrgId: person.stableUserId,
	})

	const orgId = ownerIdFromStored(`org-${crypto.randomUUID()}`)
	const teamOwner = await resolvePackageOwnerContext(env, {
		user,
		request: orgBoundRequest(personalRequest, { id: orgId, slug: 'acme' }),
	})
	expect(teamOwner).toEqual({
		ownerUserId: orgId,
		ownerScope: 'acme',
		ownerEmail: person.email,
		actorUserId: person.stableUserId,
		actorPersonalOrgId: person.stableUserId,
	})
	// Actor email stays on the owner context for display/audit, but
	// entitlement lookups must blank it so the team org plan resolves.
	expect(packageOwnerEntitlementEmail(teamOwner)).toBeNull()
	expect(
		packageOwnerEntitlementEmail(
			await resolvePackageOwnerContext(env, {
				user,
				request: personalRequest,
			}),
		),
	).toBe(person.email)

	await expect(
		resolvePackageOwnerContext(env, {
			user,
			request: orgBoundRequest(personalRequest, { id: orgId, slug: null }),
		}),
	).rejects.toThrow(/has no slug/)

	// Email on the caller context can drift (for example mid-request email
	// change) while stable_user_id stays authoritative: package scope must
	// still resolve from identity, not email.
	const staleEmail = `stale-${crypto.randomUUID()}@example.com`
	expect(
		await resolvePackageOwnerContext(env, {
			user: { ...user, email: staleEmail },
			request: personalRequest,
		}),
	).toEqual({
		ownerUserId: person.stableUserId,
		ownerScope: person.username,
		ownerEmail: staleEmail,
		actorUserId: person.stableUserId,
		actorPersonalOrgId: person.stableUserId,
	})
})
