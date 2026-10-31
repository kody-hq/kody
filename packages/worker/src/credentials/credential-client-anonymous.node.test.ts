import { expect, test, vi } from 'vitest'
import { signCredentialClientHandle } from './credential-client-handle.ts'
import { openCredentialClient } from './credential-client.ts'

import {
	createCredentialClientFixtures,
	rejection,
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

const { setup } = createCredentialClientFixtures(scheduledAudits)

test('a client never opens without a run binding, so it cannot fail later at first use', async () => {
	const t = await setup()
	await t.storeKey({ name: 'resend-prod' })
	const request = t.requestAs('bea', 'owner')
	for (const binding of ['', '   ']) {
		await expect(
			rejection(
				openCredentialClient(
					{ ...t.contextFor({ request }), binding },
					{ key: 'resend' },
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
