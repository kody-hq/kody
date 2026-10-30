import { expect, test, vi } from 'vitest'
import { executeGatewayFetch } from '#mcp/fetch-gateway.ts'
import { credentialClientHeaderName } from './credential-client-header.ts'
import { signCredentialClientHandle } from './credential-client-handle.ts'
import {
	applyCredentialClient,
	openCredentialClient,
	signWithCredentialClient,
} from './credential-client.ts'
import {
	createPackageAppRequestVisit,
	packageAppVisitTicketHeaderName,
} from '#worker/package-runtime/package-app-visit-ticket.ts'

import {
	createCredentialClientFixtures,
	rejection,
	resendKey,
} from '#worker/test-support/credential-client-fixtures.ts'

// These cases cover fills the owner has opted in to; enforcement of the
// opt-in itself is covered in fill-placement-enforcement.node.test.ts.
vi.mock(
	'#worker/credentials/fill-placement-opt-ins.ts',
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import('#worker/credentials/fill-placement-opt-ins.ts')
		>()),
		readFillPlacementOptIn: async () => ({
			query: true,
			path: true,
			body: true,
		}),
	}),
)

const scheduledAudits = vi.hoisted(() => [] as Array<Promise<unknown>>)

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: (promise: Promise<unknown>) => {
		scheduledAudits.push(promise)
	},
}))

vi.mock(
	'#worker/test-support/apply-all-migrations.ts',
	async (importOriginal) =>
		(await import('./cached-migrations.test-support.ts')).withCachedMigrations(
			await importOriginal(),
		),
)

const { setupVisitorApp } = createCredentialClientFixtures(scheduledAudits)

test('an anonymous app request opens, signs, and fetches with its own binding, and another request refuses its handle', async () => {
	const t = await setupVisitorApp()
	const audience = {
		host: 'https://rooms.example.com',
		packageId: t.packageId,
		kodyId: 'rooms',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
	}
	const visit = () =>
		createPackageAppRequestVisit({
			env: t.env,
			visitor: null,
			owner: {
				userId: t.acmeId,
				orgSlug: 'example',
				email: '',
				displayName: 'Example',
			},
			audience,
			request: null,
		})
	const first = await visit()
	const second = await visit()
	expect(first.ticket).toBeTruthy()
	expect(first.credentialClientBinding).not.toBe(second.credentialClientBinding)
	const contextFor = (binding: string) => ({
		...t.appContext(null),
		binding,
	})
	const opened = await openCredentialClient(
		contextFor(first.credentialClientBinding),
		{ key: 'database' },
	)
	const hmac = {
		handle: opened.handle,
		host: 'db.example.com',
		operation: {
			type: 'hmac',
			algorithm: 'hmac-sha256',
			message: '1700000000.{"id":1}',
			encoding: 'hex',
		},
	}
	// A later RPC in the same request rebuilds its context from the ticket.
	await expect(
		signWithCredentialClient(contextFor(first.credentialClientBinding), hmac),
	).resolves.toMatchObject({ signature: expect.stringMatching(/^[0-9a-f]+$/) })
	const placed = await applyCredentialClient({
		env: t.env,
		request: null,
		baseUrl: 'https://example.com',
		packageId: t.packageId,
		binding: first.credentialClientBinding,
		ownerCredentialScope: t.scope,
		token: opened.handle,
		requestUrl: new URL('https://db.example.com/v1/rooms'),
	})
	expect(placed.placement).toMatchObject({ value: `Bearer ${resendKey}` })

	// The gateway takes the binding from the anonymous ticket, not warm props.
	const seen: Array<Request> = []
	const response = await executeGatewayFetch({
		env: t.env,
		props: {
			baseUrl: 'https://example.com',
			userId: t.acmeId,
			email: '',
			request: null,
			storageContext: null,
			visitAudience: audience,
			ownerCredentialScope: t.scope,
			credentialClientBinding: second.credentialClientBinding,
		},
		request: new Request('https://db.example.com/v1/rooms', {
			headers: {
				[credentialClientHeaderName]: opened.handle,
				[packageAppVisitTicketHeaderName]: first.ticket!,
			},
		}),
		globalFetch: (async (outbound: Request) => {
			seen.push(outbound)
			return new Response('ok')
		}) as unknown as typeof fetch,
	})
	expect(response.status).toBe(200)
	expect(seen[0]?.headers.get('authorization')).toBe(`Bearer ${resendKey}`)
	expect(seen[0]?.headers.has(packageAppVisitTicketHeaderName)).toBe(false)

	// The other anonymous request cannot use the first one's handle.
	await expect(
		rejection(
			signWithCredentialClient(
				contextFor(second.credentialClientBinding),
				hmac,
			),
		),
	).resolves.toMatchObject({ body: { code: 'invalid_request' } })
	await expect(
		applyCredentialClient({
			env: t.env,
			request: null,
			baseUrl: 'https://example.com',
			packageId: t.packageId,
			binding: second.credentialClientBinding,
			ownerCredentialScope: t.scope,
			token: opened.handle,
			requestUrl: new URL('https://db.example.com/v1/rooms'),
		}),
	).rejects.toMatchObject({ body: { code: 'invalid_request' } })
	seen.length = 0
	await expect(
		executeGatewayFetch({
			env: t.env,
			props: {
				baseUrl: 'https://example.com',
				userId: t.acmeId,
				email: '',
				request: null,
				storageContext: null,
				visitAudience: audience,
				ownerCredentialScope: t.scope,
				credentialClientBinding: first.credentialClientBinding,
			},
			request: new Request('https://db.example.com/v1/rooms', {
				headers: {
					[credentialClientHeaderName]: opened.handle,
					[packageAppVisitTicketHeaderName]: second.ticket!,
				},
			}),
			globalFetch: (async (outbound: Request) => {
				seen.push(outbound)
				return new Response('ok')
			}) as unknown as typeof fetch,
		}),
	).rejects.toMatchObject({ body: { code: 'invalid_request' } })
	expect(seen).toHaveLength(0)
})

test('a client never opens without a run binding, so it cannot fail later at first use', async () => {
	const t = await setupVisitorApp()
	for (const binding of ['', '   ']) {
		await expect(
			rejection(
				openCredentialClient(
					{ ...t.appContext(null), binding },
					{ key: 'database' },
				),
			),
		).resolves.toMatchObject({
			body: { code: 'invalid_request' },
			message: expect.stringContaining(
				'no request-scoped credential client binding',
			),
		})
	}
	await expect(
		signCredentialClientHandle({
			env: t.env,
			handle: {
				id: 'credential-1',
				kind: 'secret',
				name: 'rooms-db',
				scope: 'org',
				org: t.acmeId,
				actor: t.people.bea.personId,
				binding: '',
			},
		}),
	).rejects.toThrow('run binding')
})
