import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { type RuntimePackageAppVisitor } from '@kody-internal/shared/runtime-worker.ts'
import {
	createPackageAppRequestVisit,
	endPackageAppVisit,
	endPackageAppVisitWithResponse,
	forgetPackageAppVisitLiveForTests,
	mintPackageAppVisitTicket,
	packageAppVisitTicketPrefix,
	packageAppVisitTicketTtlMs,
	PackageAppVisitTicketError,
	resetPackageAppVisitNoncesForTests,
	verifyPackageAppVisitTicket,
	verifyPackageAppVisitTicketFromRequest,
	withPackageAppVisitTicket,
	type PackageAppVisitAudience,
} from './package-app-visit-ticket.ts'
import { packageAppVisitorHeaderName } from './package-app-visitor-header.ts'

const secretEnv = {
	SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
} as Pick<Env, 'SECRET_STORE_KEY'>

const audience: PackageAppVisitAudience = {
	host: 'https://apps.example',
	packageId: 'pkg-1',
	kodyId: 'demo',
	sourceId: 'src-1',
	publishedCommit: 'commit-1',
}

const visitorA: RuntimePackageAppVisitor = {
	userId: personIdFromStored('person-a'),
	username: 'alpha',
	role: 'owner',
}
const visitorB: RuntimePackageAppVisitor = {
	userId: personIdFromStored('person-b'),
	username: 'beta',
	role: 'member',
}
const owner = {
	userId: ownerIdFromStored('org-1'),
	orgSlug: 'acme',
	email: 'owner@example.com',
	displayName: 'Acme',
}

function mintFor(
	visitor: RuntimePackageAppVisitor,
	extra: Partial<Parameters<typeof mintPackageAppVisitTicket>[0]> = {},
) {
	return mintPackageAppVisitTicket({
		env: secretEnv,
		visitor,
		owner,
		audience,
		credentialClientBinding: `run:${visitor.userId}`,
		...extra,
	})
}

test('a visit ticket names only its visitor and refuses another visitor, app, commit, or host', async () => {
	resetPackageAppVisitNoncesForTests()
	const a = await mintFor(visitorA)
	const b = await mintFor(visitorB)
	const claimsA = await verifyPackageAppVisitTicket({
		env: secretEnv,
		ticket: a.ticket,
		audience,
	})
	const claimsB = await verifyPackageAppVisitTicket({
		env: secretEnv,
		ticket: b.ticket,
		audience,
	})
	expect(claimsA.visitor).toEqual(visitorA)
	expect(claimsA.credentialClientBinding).toBe('run:person-a')
	expect(claimsB.visitor).toEqual(visitorB)
	expect(claimsB.credentialClientBinding).toBe('run:person-b')
	expect(claimsA.visitor.userId).not.toBe(claimsB.visitor.userId)
	expect(claimsA.nonce).not.toBe(claimsB.nonce)

	await expect(
		verifyPackageAppVisitTicket({
			env: secretEnv,
			ticket: a.ticket,
			audience: { ...audience, packageId: 'pkg-other' },
		}),
	).rejects.toBeInstanceOf(PackageAppVisitTicketError)
	await expect(
		verifyPackageAppVisitTicket({
			env: secretEnv,
			ticket: a.ticket,
			audience: { ...audience, publishedCommit: 'commit-other' },
		}),
	).rejects.toBeInstanceOf(PackageAppVisitTicketError)
	await expect(
		verifyPackageAppVisitTicket({
			env: secretEnv,
			ticket: a.ticket,
			audience: { ...audience, host: 'https://other.example' },
		}),
	).rejects.toBeInstanceOf(PackageAppVisitTicketError)
})

test('a package app visit ticket binds the live consent grant scopes', async () => {
	resetPackageAppVisitNoncesForTests()
	const minted = await mintFor(visitorA, {
		grantId: 'grant-live',
		scopes: ['profile', 'email', 'need:calendar'],
	})
	const claims = await verifyPackageAppVisitTicket({
		env: secretEnv,
		ticket: minted.ticket,
		audience,
	})
	expect(claims.grantId).toBe('grant-live')
	expect(claims.scopes).toEqual(['profile', 'email', 'need:calendar'])
})

test('a replayed, expired, or forged visit ticket is refused', async () => {
	resetPackageAppVisitNoncesForTests()
	const now = 1_700_000_000_000
	const minted = await mintFor(visitorA, { now })
	await verifyPackageAppVisitTicket({
		env: secretEnv,
		ticket: minted.ticket,
		audience,
		now,
	})

	endPackageAppVisit(minted.nonce)
	await expect(
		verifyPackageAppVisitTicket({
			env: secretEnv,
			ticket: minted.ticket,
			audience,
			now,
		}),
	).rejects.toBeInstanceOf(PackageAppVisitTicketError)

	resetPackageAppVisitNoncesForTests()
	const otherIsolate = await mintFor(visitorA, { now })
	forgetPackageAppVisitLiveForTests(otherIsolate.nonce)
	await verifyPackageAppVisitTicket({
		env: secretEnv,
		ticket: otherIsolate.ticket,
		audience,
		now,
	})
	await expect(
		verifyPackageAppVisitTicket({
			env: secretEnv,
			ticket: otherIsolate.ticket,
			audience,
			now: now + packageAppVisitTicketTtlMs + 1,
		}),
	).rejects.toBeInstanceOf(PackageAppVisitTicketError)

	resetPackageAppVisitNoncesForTests()
	const live = await mintFor(visitorA, { now })
	await expect(
		verifyPackageAppVisitTicket({
			env: secretEnv,
			ticket: live.ticket,
			audience,
			now: now + packageAppVisitTicketTtlMs + 1,
		}),
	).resolves.toMatchObject({ nonce: live.nonce })

	const [prefix, payload, signature] = [
		packageAppVisitTicketPrefix,
		...live.ticket.slice(packageAppVisitTicketPrefix.length).split('.'),
	]
	expect(payload && signature).toBeTruthy()
	const forgedSig = `${prefix}${payload}.${String(signature)}x`
	await expect(
		verifyPackageAppVisitTicket({
			env: secretEnv,
			ticket: forgedSig,
			audience,
			now,
		}),
	).rejects.toBeInstanceOf(PackageAppVisitTicketError)
	await expect(
		verifyPackageAppVisitTicket({
			env: secretEnv,
			ticket: `${prefix}not-json.sig`,
			audience,
			now,
		}),
	).rejects.toBeInstanceOf(PackageAppVisitTicketError)
	await expect(
		verifyPackageAppVisitTicket({
			env: { SECRET_STORE_KEY: 'a-different-secret-store-key-32chars' },
			ticket: live.ticket,
			audience,
			now,
		}),
	).rejects.toBeInstanceOf(PackageAppVisitTicketError)
})

test('the visit ticket header is platform-set and verify reads only that header', async () => {
	resetPackageAppVisitNoncesForTests()
	const minted = await mintFor(visitorA)
	const request = withPackageAppVisitTicket(
		new Request('https://apps.example/app', {
			headers: { [packageAppVisitorHeaderName]: '{"userId":"forged"}' },
		}),
		minted.ticket,
	)
	const claims = await verifyPackageAppVisitTicketFromRequest({
		env: secretEnv,
		request,
		audience,
	})
	expect(claims?.visitor).toEqual(visitorA)
	expect(
		await verifyPackageAppVisitTicketFromRequest({
			env: secretEnv,
			request: new Request('https://apps.example/app'),
			audience,
		}),
	).toBeNull()
})

test('createPackageAppRequestVisit mints a ticket only when the visitor is the actor', async () => {
	resetPackageAppVisitNoncesForTests()
	const request = {
		org: { id: owner.userId, slug: owner.orgSlug },
		actor: { userId: visitorA.userId, username: visitorA.username },
		attribution: { kind: 'user' as const, userId: visitorA.userId },
		credential: {
			kind: 'package-app' as const,
			id: null,
			orgId: owner.userId,
			scopes: null,
			profileName: null,
		},
		membership: { role: 'owner' as const },
	}
	const acting = await createPackageAppRequestVisit({
		env: secretEnv,
		visitor: visitorA,
		owner,
		audience,
		request,
	})
	expect(acting.ticket).toMatch(/^kvt1\./)
	expect(acting.visitor).toEqual(visitorA)
	expect(acting.credentialClientBinding).toMatch(/^run:/)
	const claims = await verifyPackageAppVisitTicket({
		env: secretEnv,
		ticket: acting.ticket!,
		audience,
	})
	expect(claims.visitor).toEqual(visitorA)
	expect(claims.credentialClientBinding).toBe(acting.credentialClientBinding)

	const anonymous = await createPackageAppRequestVisit({
		env: secretEnv,
		visitor: null,
		owner,
		audience,
		request: null,
	})
	expect(anonymous.ticket).toBeNull()
	expect(anonymous.visitor).toBeNull()
	expect(anonymous.request).toBeNull()
	expect(anonymous.credentialClientBinding).toMatch(/^run:/)
	expect(anonymous.credentialClientBinding).not.toBe(
		acting.credentialClientBinding,
	)
})

test('endPackageAppVisitWithResponse keeps the ticket live until the body ends', async () => {
	resetPackageAppVisitNoncesForTests()
	const minted = await mintFor(visitorA)
	const { readable, writable } = new TransformStream()
	const response = endPackageAppVisitWithResponse(
		new Response(readable),
		minted.nonce,
	)
	await verifyPackageAppVisitTicket({
		env: secretEnv,
		ticket: minted.ticket,
		audience,
	})
	const writer = writable.getWriter()
	await writer.write(new TextEncoder().encode('chunk'))
	await writer.close()
	await expect(response.text()).resolves.toBe('chunk')
	await vi.waitFor(async () => {
		await expect(
			verifyPackageAppVisitTicket({
				env: secretEnv,
				ticket: minted.ticket,
				audience,
			}),
		).rejects.toBeInstanceOf(PackageAppVisitTicketError)
	})
})

test('endPackageAppVisitWithResponse burns the nonce when the client cancels', async () => {
	resetPackageAppVisitNoncesForTests()
	const minted = await mintFor(visitorA)
	const { readable } = new TransformStream()
	const response = endPackageAppVisitWithResponse(
		new Response(readable),
		minted.nonce,
	)
	await verifyPackageAppVisitTicket({
		env: secretEnv,
		ticket: minted.ticket,
		audience,
	})
	await response.body?.cancel()
	await vi.waitFor(async () => {
		await expect(
			verifyPackageAppVisitTicket({
				env: secretEnv,
				ticket: minted.ticket,
				audience,
			}),
		).rejects.toBeInstanceOf(PackageAppVisitTicketError)
	})
})

test('an outside-org visitor gets an executor-only ticket that names them without a role', async () => {
	resetPackageAppVisitNoncesForTests()
	const outsider = await createPackageAppRequestVisit({
		env: secretEnv,
		visitor: null,
		owner,
		audience,
		request: null,
		grantId: 'grant-outsider',
		scopes: ['profile', 'need:github'],
		executorVisitor: visitorB,
	})
	expect(outsider.ticket).toMatch(/^kvt1\./)
	expect(outsider.visitor).toBeNull()
	expect(outsider.request).toBeNull()
	const claims = await verifyPackageAppVisitTicket({
		env: secretEnv,
		ticket: outsider.ticket!,
		audience,
	})
	expect(claims).toMatchObject({
		executorOnly: true,
		visitor: { userId: visitorB.userId, username: 'beta', role: null },
		grantId: 'grant-outsider',
		scopes: ['profile', 'need:github'],
	})
	const member = await mintFor(visitorA)
	expect(
		(
			await verifyPackageAppVisitTicket({
				env: secretEnv,
				ticket: member.ticket,
				audience,
			})
		).executorOnly,
	).toBeUndefined()
})
