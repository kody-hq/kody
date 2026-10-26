import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { saveSecret, setSecretAllowedHosts } from '#mcp/secrets/service.ts'
import { findCredentialIdsByLegacyName } from '#worker/credentials/credential-ids.ts'
import { grantPersonalCredentialToOrg } from '#worker/credentials/personal-credentials.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

/**
 * Execute reuses one Dynamic Worker isolate per org and module graph. Each
 * run's outbound fetch must still act as that run's caller: their personal
 * credentials, token scopes, and membership. Dummy values and a stubbed
 * upstream only.
 */

type Seen = { authorization: string | null }
type Person = { username: string; stableUserId: string; personId: PersonId }
type Team = { id: OwnerId; slug: string }
type CallerOptions = {
	apiTokenScopes?: Array<OrgPermission>
}

const testEnv = env as Env & {
	TEST_MIGRATIONS: Array<D1Migration>
	TEST_AUDIT_MIGRATIONS: Array<D1Migration>
}

beforeAll(async () => {
	await applyD1Migrations(testEnv.APP_DB, testEnv.TEST_MIGRATIONS)
	await applyD1Migrations(testEnv.AUDIT_DB, testEnv.TEST_AUDIT_MIGRATIONS)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

function installFakeUpstream() {
	const seen: Array<Seen> = []
	const realFetch = globalThis.fetch
	vi.stubGlobal(
		'fetch',
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input as RequestInfo, init)
			if (new URL(request.url).hostname !== 'upstream.example.com') {
				return realFetch(input as RequestInfo, init)
			}
			seen.push({ authorization: request.headers.get('authorization') })
			return Response.json({ ok: true })
		},
	)
	return seen
}

async function createPerson(prefix: string): Promise<Person> {
	const username = `${prefix}${crypto.randomUUID().slice(0, 8)}`
	const stableUserId = `u-${crypto.randomUUID()}`
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id, personal_org_id)
		 VALUES (?, ?, 'x', ?, ?)`,
	)
		.bind(username, `${username}@example.com`, stableUserId, stableUserId)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId,
		username,
		createdAt: new Date().toISOString(),
	})
	return { username, stableUserId, personId: personIdFromStored(stableUserId) }
}

async function createTeam(
	owner: Person,
	members: Array<Person>,
): Promise<Team> {
	const slug = `team-${crypto.randomUUID().slice(0, 8)}`
	const created = await createOrganization(env.APP_DB, env, {
		personId: owner.personId,
		audit: {
			appDb: env.APP_DB,
			db: env.AUDIT_DB,
			actorUserId: owner.stableUserId,
			actorUsername: owner.username,
			credentialKind: null,
			credentialId: null,
		},
		slug,
		displayName: 'Team',
	})
	if (!created.ok) throw new Error(created.error)
	const row = await env.APP_DB.prepare(`SELECT id FROM orgs WHERE slug = ?`)
		.bind(slug)
		.first<{ id: string }>()
	const id = ownerIdFromStored(row!.id)
	for (const member of members) {
		await env.APP_DB.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'member', ?)`,
		)
			.bind(id, member.stableUserId, new Date().toISOString())
			.run()
	}
	return { id, slug }
}

async function savePersonalSecret(
	person: Person,
	value: string,
	grantToOrg?: OwnerId,
) {
	const owner = personalOrgId(person.personId)
	const name = 'probeToken'
	await saveSecret({
		env,
		userId: owner,
		scope: 'user',
		name,
		value,
		audit: null,
	})
	await setSecretAllowedHosts({
		env,
		userId: owner,
		scope: 'user',
		name,
		allowedHosts: ['upstream.example.com'],
		audit: null,
	})
	if (!grantToOrg) return
	const [credentialId] = await findCredentialIdsByLegacyName(
		env.APP_DB,
		owner,
		{ type: 'secret', name },
	)
	if (!credentialId) throw new Error('credential id not found')
	await grantPersonalCredentialToOrg({
		db: env.APP_DB,
		ownerPersonId: person.personId,
		credentialId,
		orgId: grantToOrg,
	})
}

function caller(
	person: Person,
	team: Team | null,
	options: CallerOptions = {},
) {
	return createMcpCallerContext({
		source: options.apiTokenScopes
			? { kind: 'api-token', tokenId: 'tok-test' }
			: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.dev',
		user: {
			userId: person.personId,
			username: person.username,
			email: `${person.username}@example.com`,
			displayName: person.username,
			personalOrgId: personalOrgId(person.personId),
		},
		...(team
			? {
					orgBinding: {
						org: { id: team.id, slug: team.slug },
						role: 'member' as const,
					},
				}
			: {}),
		...(options.apiTokenScopes ? { scopes: options.apiTokenScopes } : {}),
	})
}

async function buildProbe() {
	return await buildKodyModuleBundle({
		env,
		baseUrl: 'https://kody.dev',
		userId: 'probe-builder',
		sourceFiles: {
			'main.ts': `const SCENARIO = ${JSON.stringify(crypto.randomUUID())}
export default async function main() {
	const res = await fetch('https://upstream.example.com/probe', {
		method: 'POST',
		headers: { Authorization: 'Bearer {{secret:probeToken|scope=user}}' },
	})
	return { status: res.status, scenario: SCENARIO }
}`,
		},
		entryPoint: 'main.ts',
	})
}

type Bundle = Awaited<ReturnType<typeof buildProbe>>

async function run(
	callerContext: ReturnType<typeof caller>,
	bundle: Bundle,
	workerIds: Array<string>,
) {
	return await runBundledModuleWithRegistry(
		env,
		callerContext,
		bundle,
		undefined,
		{
			skipCapabilityRegistry: true,
			claimWorkerDay: async (workerId: string) => {
				workerIds.push(workerId)
				return { created: true }
			},
		},
	)
}

function authorizations(seen: Array<Seen>) {
	return seen.splice(0).map((entry) => entry.authorization)
}

const narrowToken: CallerOptions = { apiTokenScopes: ['package:read'] }

async function teamWithTwoMembers() {
	const owner = await createPerson('own')
	const ann = await createPerson('ann')
	const bea = await createPerson('bea')
	const team = await createTeam(owner, [ann, bea])
	return { ann, bea, team }
}

test('reused worker: each org member fills their own personal secret', async () => {
	silenceIncidentalRuntimeWarnings()
	const { ann, bea, team } = await teamWithTwoMembers()
	await savePersonalSecret(ann, 'dummy-ann-value', team.id)
	await savePersonalSecret(bea, 'dummy-bea-value', team.id)
	const seen = installFakeUpstream()
	const bundle = await buildProbe()
	const ids: Array<string> = []

	await run(caller(ann, team), bundle, ids)
	expect(authorizations(seen)).toEqual(['Bearer dummy-ann-value'])
	await run(caller(bea, team), bundle, ids)
	expect(ids[0]).toBe(ids[1])
	expect(authorizations(seen)).toEqual(['Bearer dummy-bea-value'])
})

test('fresh worker: a member fills their own personal secret', async () => {
	silenceIncidentalRuntimeWarnings()
	const { ann, bea, team } = await teamWithTwoMembers()
	await savePersonalSecret(ann, 'dummy-ann-value', team.id)
	await savePersonalSecret(bea, 'dummy-bea-value', team.id)
	const seen = installFakeUpstream()
	await run(caller(bea, team), await buildProbe(), [])
	expect(authorizations(seen)).toEqual(['Bearer dummy-bea-value'])
})

test("reused worker: a member without the secret gets no other member's value", async () => {
	silenceIncidentalRuntimeWarnings()
	const { ann, bea, team } = await teamWithTwoMembers()
	await savePersonalSecret(ann, 'dummy-ann-value', team.id)
	const seen = installFakeUpstream()
	const bundle = await buildProbe()
	const ids: Array<string> = []
	await run(caller(ann, team), bundle, ids)
	authorizations(seen)
	await run(caller(bea, team), bundle, ids)
	expect(ids[0]).toBe(ids[1])
	expect(authorizations(seen).join(' ')).not.toContain('dummy-ann-value')
})

test('reused worker: a narrower token run keeps its own scopes', async () => {
	silenceIncidentalRuntimeWarnings()
	const ann = await createPerson('ann')
	await savePersonalSecret(ann, 'dummy-ann-value')
	const seen = installFakeUpstream()

	await run(caller(ann, null, narrowToken), await buildProbe(), [])
	expect(authorizations(seen).join(' ')).not.toContain('dummy-ann-value')

	const bundle = await buildProbe()
	const ids: Array<string> = []
	await run(caller(ann, null), bundle, ids)
	expect(authorizations(seen)).toEqual(['Bearer dummy-ann-value'])
	await run(caller(ann, null, narrowToken), bundle, ids)
	expect(ids[0]).toBe(ids[1])
	expect(authorizations(seen).join(' ')).not.toContain('dummy-ann-value')
})

test('reused worker: a full-scope run after a narrower token run keeps its scopes', async () => {
	silenceIncidentalRuntimeWarnings()
	const ann = await createPerson('ann')
	await savePersonalSecret(ann, 'dummy-ann-value')
	const seen = installFakeUpstream()
	const bundle = await buildProbe()
	const ids: Array<string> = []
	await run(caller(ann, null, narrowToken), bundle, ids)
	authorizations(seen)
	await run(caller(ann, null), bundle, ids)
	expect(ids[0]).toBe(ids[1])
	expect(authorizations(seen)).toEqual(['Bearer dummy-ann-value'])
})
