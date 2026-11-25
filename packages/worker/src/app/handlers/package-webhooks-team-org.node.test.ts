import { expect, test, vi } from 'vitest'
import type * as PackageRegistrySourceModule from '#worker/package-registry/source.ts'
import {
	mintPackageWebhook,
	readPackageWebhooksData,
	revealPackageWebhook,
	rotatePackageWebhook,
} from '#app/handlers/package-webhooks.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
import { createTestOrgAuditWriter } from '#worker/test-support/create-audit-db.ts'
import {
	type MappingFixturePerson,
	setupPackageCredentialMappingFixture,
} from '#worker/test-support/package-credential-mapping-fixture.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import type {
	PackageWebhooksActionPayload,
	PackageWebhooksLoaderData,
} from '#universal/loader-data.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/package-registry/source.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageRegistrySourceModule>()),
	loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
}))

const teamParams = { username: 'acme-clients', kodyId: 'digest' }
const requestUrl = 'https://kody.example/@acme-clients/digest/settings'

// bea owns acme-clients, ann is a plain member, cy belongs only to her own
// personal org.
async function setup() {
	const fixture = await setupPackageCredentialMappingFixture({
		loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
	})
	const signInAs = (person: MappingFixturePerson) => {
		const mcpUser = {
			userId: fixture.people[person].personId,
			username: person,
		}
		mocks.readAuthenticatedAppUser.mockResolvedValue({
			email: `${person}@example.com`,
			username: person,
			mcpUser,
			request: deriveRequestContext({
				user: mcpUser,
				source: { kind: 'session' },
			}),
		})
	}
	const grantManage = async (person: MappingFixturePerson) => {
		await upsertGrant({
			db: fixture.db,
			orgId: fixture.acmeId,
			resourceType: 'package',
			resourceId: fixture.savedPackage.id,
			family: 'package',
			subject: { type: 'user', id: fixture.people[person].stableUserId },
			preset: 'manage',
			permissions: null,
			createdByUserId: fixture.people.bea.stableUserId,
			audit: createTestOrgAuditWriter(),
		})
	}
	const list = async () => {
		const result = await readPackageWebhooksData(
			new Request(requestUrl),
			teamParams,
			fixture.env,
		)
		return result.status === 200
			? { status: result.status, body: result.data }
			: { status: result.status, body: { ok: false, error: result.error } }
	}
	const act = async (
		operation:
			| typeof mintPackageWebhook
			| typeof rotatePackageWebhook
			| typeof revealPackageWebhook,
	) => {
		const response = await operation({
			env: fixture.env,
			request: new Request(requestUrl),
			params: teamParams,
			webhookName: 'incoming',
		})
		return {
			status: response.status,
			body: response.data as PackageWebhooksActionPayload & { error?: string },
		}
	}
	return { ...fixture, signInAs, grantManage, list, act }
}

async function useEveryWebhookOperation(t: Awaited<ReturnType<typeof setup>>) {
	const listed = await t.list()
	const minted = await t.act(mintPackageWebhook)
	const revealed = await t.act(revealPackageWebhook)
	const rotated = await t.act(rotatePackageWebhook)
	return { listed, minted, revealed, rotated }
}

function expectFullWebhookAccess(
	used: Awaited<ReturnType<typeof useEveryWebhookOperation>>,
) {
	const { listed, minted, revealed, rotated } = used
	expect(listed.status).toBe(200)
	const body = listed.body as PackageWebhooksLoaderData
	expect(body).toMatchObject({
		ok: true,
		username: 'acme-clients',
		kodyId: 'digest',
	})
	expect(body.webhooks.map((webhook) => webhook.name)).toEqual(['incoming'])
	expect(minted.status).toBe(200)
	const mintedUrl = minted.body.revealed!.url
	expect(mintedUrl).toMatch(
		/^https:\/\/kody\.example\/@acme-clients\/webhooks\/digest\/incoming\/[A-Za-z0-9_-]+$/,
	)
	expect(minted.body.approvalUrl).toMatch(
		/^https:\/\/kody\.example\/@acme-clients\/digest\/approve-credentials\?/,
	)
	expect(revealed.status).toBe(200)
	expect(revealed.body.revealed!.url).toBe(mintedUrl)
	expect(rotated.status).toBe(200)
	expect(rotated.body.revealed!.url).not.toBe(mintedUrl)
}

test('a team org owner lists, mints, reveals, and rotates package webhooks', async () => {
	const t = await setup()
	t.signInAs('bea')
	const used = await useEveryWebhookOperation(t)
	expect(used.listed.status).toBe(200)
	expectFullWebhookAccess(used)
})

test('a member with Manage access on the package lists, mints, reveals, and rotates its webhooks', async () => {
	const t = await setup()
	await t.grantManage('ann')
	t.signInAs('ann')
	const used = await useEveryWebhookOperation(t)
	expect(used.listed.status).toBe(200)
	expectFullWebhookAccess(used)
})

test('a plain member who can use the package is told why webhooks are hidden and cannot mint or reveal', async () => {
	const t = await setup()
	await t.grantPackageUse('ann')
	t.signInAs('ann')
	const reason =
		'Only org Owners and people with Manage access on this package can see its webhooks.'
	expect(await t.list()).toEqual({
		status: 403,
		body: { ok: false, error: reason },
	})
	for (const operation of [
		mintPackageWebhook,
		revealPackageWebhook,
		rotatePackageWebhook,
	]) {
		const denied = await t.act(operation)
		expect(denied).toEqual({ status: 403, body: { ok: false, error: reason } })
	}
})

test('a plain member without package access and an outsider get a 404 that names nothing', async () => {
	const t = await setup()
	t.signInAs('bea')
	expect((await t.act(mintPackageWebhook)).status).toBe(200)

	for (const person of ['ann', 'cy'] as const) {
		t.signInAs(person)
		const listed = await t.list()
		expect(listed).toEqual({
			status: 404,
			body: { ok: false, error: 'Package not found.' },
		})
		for (const operation of [
			mintPackageWebhook,
			revealPackageWebhook,
			rotatePackageWebhook,
		]) {
			const denied = await t.act(operation)
			expect(denied.status).toBe(404)
			expect(JSON.stringify(denied.body)).not.toMatch(/incoming|whh_|https:/)
		}
	}
})
