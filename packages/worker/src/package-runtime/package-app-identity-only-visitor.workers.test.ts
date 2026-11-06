import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { setupServedPackageApp } from '#worker/test-support/served-package-app.ts'
import {
	createPackageAppSessionCookie,
	readPackageAppSession,
} from '#app/package-app-session.ts'
import { handlePackageAppRequest } from '#app/handlers/package-app.ts'
import { authorizePackageAppVisitorForOrg } from '#app/package-app-origin.ts'
import { packageAppVisitorHeaderName } from './package-app-visitor-header.ts'

/**
 * A signed-in person who cannot run an internet-visible app is served as an
 * anonymous visitor with a read-only identity.
 */

const appSource = `import { hasScope, hasVisitorCredential, kody } from 'kody:runtime'
export default {
	async fetch(request) {
		const msg = (e) => String(e?.message ?? e).slice(0, 200)
		const out = {
			header: request.headers.get('X-Kody-Visitor'),
			cookie: request.headers.get('Cookie'),
			ticketKind: (request.headers.get('X-Kody-Visit-Ticket') ?? '').slice(0, 5),
		}
		out.scopes = {
			profile: hasScope(request, 'profile'),
			email: hasScope(request, 'email'),
			calendar: hasVisitorCredential(request, 'calendar'),
		}
		try { out.me = await kody.metaGetCurrentUser({}) } catch (e) { out.meError = msg(e) }
		try { out.secrets = await kody.secretList({}) } catch (e) { out.secretsError = msg(e) }
		try { out.packages = await kody.packageList({}) } catch (e) { out.packagesError = msg(e) }
		return Response.json(out)
	},
}`

const notDeclared = /not listed in kody\.app\.capabilities/

async function setup(input: { capabilities?: Array<string> } = {}) {
	return await setupServedPackageApp({ ...input, appSource })
}

test(
	'a package-app session becomes a verified visitor header without exposing its cookie',
	{ timeout: 120_000 },
	async () => {
		const t = await setup()
		const [setCookie] = await createPackageAppSessionCookie({
			env,
			session: { stableUserId: t.ownerId, username: t.username },
			slug: 'visitor-app',
			secure: true,
			expiresAt: Date.now() + 60_000,
		})
		const request = new Request(
			`https://kody.dev/@${t.username}/packages/visitor-app`,
			{ headers: { Cookie: setCookie?.split(';')[0] ?? '' } },
		)
		const parsedSession = await readPackageAppSession({
			request,
			env,
			slug: 'visitor-app',
		})
		expect(parsedSession?.session.stableUserId).toBe(t.ownerId)
		const authorized = parsedSession
			? await authorizePackageAppVisitorForOrg({
					env,
					stableUserId: parsedSession.session.stableUserId,
					issuedAt: parsedSession.issuedAt,
					handle: t.username,
					kodyId: 'visitor-app',
				})
			: null
		expect(authorized?.kind).toBe('ok')
		const response = await handlePackageAppRequest(request, env)
		expect(
			response.status,
			response.headers.get('Location') ?? 'no redirect location',
		).toBe(200)
		const body = (await response.json()) as {
			header: string
			cookie: string | null
		}
		expect(JSON.parse(body.header)).toEqual({
			userId: t.ownerId,
			username: t.username,
			role: 'owner',
			scopes: ['profile'],
		})
		expect(body.cookie).toBeNull()
	},
)

test(
	'a signed-in outsider gets their identity from metaGetCurrentUser and nothing else',
	{ timeout: 120_000 },
	async () => {
		const t = await setup()
		const outsiderId = `user-${crypto.randomUUID()}`
		const body = await t.serve({
			visitor: null,
			identity: { userId: outsiderId, username: 'outside-visitor' },
		})
		expect(body.me).toEqual({
			user_id: outsiderId,
			username: 'outside-visitor',
			email: '',
			display_name: 'outside-visitor',
			org: { slug: t.username },
			scopes: ['profile'],
		})
		expect(body.scopes).toEqual({
			profile: true,
			email: false,
			calendar: false,
		})
		expect(body.meError).toBeUndefined()
		expect(JSON.parse(String(body.header))).toEqual({
			userId: outsiderId,
			username: 'outside-visitor',
			role: null,
			scopes: ['profile'],
		})
		// No new access: undeclared calls never run as the publisher, and the
		// visitor's own identity grants nothing.
		expect(body.secrets).toBeUndefined()
		expect(String(body.secretsError)).toMatch(notDeclared)
		expect(body.packages).toBeUndefined()
		expect(String(body.packagesError)).toMatch(notDeclared)
		// Both refusals reached the app, so both count as hard rejections.
		await expect
			.poll(
				async () =>
					(
						await env.APP_DB.prepare(
							`SELECT call_name, difference_kind, visitor_hash
							 FROM package_app_authority_rejections
							 WHERE package_id = ? ORDER BY call_name`,
						)
							.bind(t.packageId)
							.all()
					).results,
				{ timeout: 15_000 },
			)
			.toEqual([
				{
					call_name: 'packageList',
					difference_kind: 'capability_not_declared',
					visitor_hash: 'anonymous',
				},
				{
					call_name: 'secretList',
					difference_kind: 'capability_not_declared',
					visitor_hash: 'anonymous',
				},
			])
	},
)

test(
	'an anonymous visitor still has no identity, even with a forged visitor header',
	{ timeout: 120_000 },
	async () => {
		const t = await setup()
		const forged = JSON.stringify({
			userId: `user-${crypto.randomUUID()}`,
			username: 'forged',
			role: 'owner',
		})
		for (const inboundHeaders of [
			undefined,
			{ [packageAppVisitorHeaderName]: forged },
		]) {
			const body = await t.serve({ visitor: null, inboundHeaders })
			// An anonymous ticket scopes credential clients to this request
			// and names nobody.
			expect(body.ticketKind).toBe('kva1.')
			expect(body.header).toBeNull()
			expect(body.me).toBeUndefined()
			expect(String(body.meError)).toMatch(/Authenticated MCP user is required/)
			expect(String(body.secretsError)).toMatch(notDeclared)
		}
	},
)

test(
	'the owner is unchanged: the bridge answers as them with their role',
	{ timeout: 120_000 },
	async () => {
		const t = await setup()
		const body = await t.serve({
			visitor: {
				userId: personIdFromStored(t.ownerId),
				username: t.username,
				role: 'owner',
			},
			// Ignored with a visitor.
			identity: { userId: `user-${crypto.randomUUID()}`, username: 'nope' },
		})
		expect(body.meError).toBeUndefined()
		expect(body.me).toMatchObject({
			user_id: t.ownerId,
			username: t.username,
			org: { slug: t.username },
		})
		expect(JSON.parse(String(body.header))).toEqual({
			userId: t.ownerId,
			username: t.username,
			role: 'owner',
			scopes: ['profile'],
		})
	},
)

test(
	'a declared capability runs as the publisher for every visitor, and nothing else does',
	{ timeout: 120_000 },
	async () => {
		const t = await setup({ capabilities: ['secretList'] })
		for (const input of [
			{ visitor: null, identity: null },
			{
				visitor: null,
				identity: {
					userId: `user-${crypto.randomUUID()}`,
					username: 'outsider',
				},
			},
		]) {
			const body = await t.serve(input)
			expect(body.secretsError).toBeUndefined()
			expect(body.secrets).toBeDefined()
			expect(body.packages).toBeUndefined()
			expect(String(body.packagesError)).toMatch(notDeclared)
		}
	},
)
