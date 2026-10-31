import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { apiTokenScopes } from '#worker/api-tokens/scopes.ts'
import { buildSecretHostApprovalUrl } from '#mcp/secrets/host-approval.ts'
import { buildSeedUserSql } from '../seed-sql.ts'
import {
	queryD1,
	resolveRehearsalDatabases,
	type CloudflareClient,
	type RehearsalDatabase,
} from './d1-rehearsal.ts'
import {
	describeFailure,
	openRehearsalSession,
	postJson,
	requestOk,
	type RehearsalSession,
} from './kody-session.ts'
import {
	deriveRehearsalPassword,
	rehearsalOrg,
	rehearsalUser,
	rehearsalUsers,
	type RehearsalOrigins,
	type RehearsalUser,
} from './rehearsal-env.ts'
import {
	integrationName,
	packageSecretName,
	personalPackageFiles,
	orgPackageFiles,
	orgPackages,
	personalPackageLeaf,
	rehearsalMemories,
	userSecretName,
} from './rehearsal-packages.ts'
import {
	callCapability,
	mintCliToken,
	readRecord,
	readStringAt,
} from './cli-token.ts'

export { callCapability, mintCliToken } from './cli-token.ts'
export type { TokenLifetime } from './cli-token.ts'

export function packageExportModule(specifier: string) {
	return [
		`import run from ${JSON.stringify(specifier)}`,
		'export default async function main(params) {',
		'\treturn run(params)',
		'}',
	].join('\n')
}

export const userSecretProofModule = (echoUrl: string) =>
	[
		'export default async function main() {',
		`\tconst response = await fetch(${JSON.stringify(echoUrl)}, {`,
		`\t\theaders: { 'x-rehearsal-secret': '{{secret:${userSecretName}}}' },`,
		'\t})',
		'\tconst body = await response.json()',
		"\treturn { status: response.status, sha256: body?.sha256?.['x-rehearsal-secret'] ?? null }",
		'}',
	].join('\n')

export const integrationProofModule = (echoUrl: string) =>
	[
		"import { createAuthenticatedFetch } from 'kody:runtime'",
		'export default async function main() {',
		`\tconst authedFetch = await createAuthenticatedFetch(${JSON.stringify(integrationName)})`,
		`\tconst response = await authedFetch(${JSON.stringify(echoUrl)})`,
		'\tconst body = await response.json()',
		'\treturn { status: response.status, bearerSent: Boolean(body?.sha256?.authorization) }',
		'}',
	].join('\n')

const integrationIdentityModule = (echoUrl: string) =>
	[
		"import { createAuthenticatedFetch } from 'kody:runtime'",
		'export default async function main() {',
		`\tconst authedFetch = await createAuthenticatedFetch(${JSON.stringify(integrationName)})`,
		`\tconst response = await authedFetch(${JSON.stringify(echoUrl)})`,
		'\tconst body = await response.json()',
		'\treturn { status: response.status, authorizationSha256: body?.sha256?.authorization ?? null }',
		'}',
	].join('\n')

/**
 * The grantee (carol, bound to alice's org) uses alice's user secret and
 * integration as ad-hoc code, which needs her per-credential Use grants.
 * Every rehearsal user has a secret and an integration with the same names,
 * so each proof must match the owner's own hash taken alongside it: a grant
 * that stops working, or resolves to another user's credential, throws.
 * Integration tokens refresh hourly, so only the match is returned. The seed
 * also passes the owner's seeded secret hash; the snapshot diffs the owner's
 * own secret proof instead.
 */
export async function credentialGranteeProofs(input: {
	grantee: RehearsalSession
	owner: RehearsalSession
	echoUrl: string
	ownerSecretSha256?: string | null
}) {
	const run = async (session: RehearsalSession, code: string, label: string) =>
		readRecord(await session.execute(code), label)
	const secret = await run(
		input.grantee,
		userSecretProofModule(input.echoUrl),
		'grantee secret proof',
	)
	const ownerSecret = await run(
		input.owner,
		userSecretProofModule(input.echoUrl),
		'owner secret proof',
	)
	const integration = await run(
		input.grantee,
		integrationIdentityModule(input.echoUrl),
		'grantee integration proof',
	)
	const ownerIntegration = await run(
		input.owner,
		integrationIdentityModule(input.echoUrl),
		'owner integration proof',
	)
	const proofs = {
		secretMatchesOwner:
			typeof ownerSecret.sha256 === 'string' &&
			secret.sha256 === ownerSecret.sha256 &&
			(input.ownerSecretSha256 === undefined ||
				ownerSecret.sha256 === input.ownerSecretSha256),
		integrationMatchesOwner:
			typeof ownerIntegration.authorizationSha256 === 'string' &&
			integration.authorizationSha256 === ownerIntegration.authorizationSha256,
	}
	if (!proofs.secretMatchesOwner || !proofs.integrationMatchesOwner) {
		throw new Error(
			`carol could not use alice's secret and integration through her Use grants: ${JSON.stringify(
				{
					...proofs,
					secretStatus: secret.status,
					integrationStatus: integration.status,
				},
			)}`,
		)
	}
	return proofs
}

/** Credential ids of alice's org-level user secret and integration. */
async function aliceCredentialIds(session: RehearsalSession) {
	const secrets = readRecord(
		await callCapability(session, 'secretList', { scope: 'user' }),
		'secretList',
	).secrets
	const integrations = readRecord(
		await callCapability(session, 'integrationList'),
		'integrationList',
	).integrations
	const secret = (Array.isArray(secrets) ? secrets : []).find(
		(entry) => readRecord(entry, 'secretList entry').name === userSecretName,
	)
	const integration = (Array.isArray(integrations) ? integrations : []).find(
		(entry) =>
			readRecord(entry, 'integrationList entry').name === integrationName,
	)
	return [
		readStringAt(secret, ['credential_id'], 'secretList entry'),
		readStringAt(integration, ['credentialId'], 'integrationList entry'),
	]
}

function randomSecretValue() {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		'base64url',
	)
}

type SeedLog = (line: string) => void

type SeededPerson = {
	role: RehearsalUser['role']
	email: string
	username: string
	stableUserId: string
	origin: RehearsalUser['origin']
	packageId: string | null
	packageName: string | null
	webhookHandle: string | null
	jobIds: Array<string>
	userSecretSha256: string | null
	packageSecretSha256: string | null
}

export type SeedManifest = {
	version: 1
	workerName: string
	seededAt: string
	origins: RehearsalOrigins
	people: Array<SeededPerson>
	org: {
		id: string
		slug: string
		owner: RehearsalUser['role']
		packages: Array<{ leaf: string; visibility: string; packageId: string }>
		listingId: string
		forkedBy: string
		forkPackageId: string
	}
	grants: {
		/** alice's org grants carol Use on alice's package. */
		useGrantId: string
		/** carol's org invites alice to Use carol's package (pending). */
		pendingInviteId: string
	}
	autoRefill: { role: RehearsalUser['role'] }
}

export type SeedCredentials = {
	version: 1
	workerName: string
	origins: RehearsalOrigins
	users: Array<{
		role: RehearsalUser['role']
		email: string
		username: string
		/** Personal org slug for `?org=` on consent; handles are permanent. */
		orgSlug: string
		password: string
		cliToken: string
		everyScopeToken: string
	}>
}

type SeedInput = {
	client: CloudflareClient
	workerName: string
	origins: RehearsalOrigins
	passwordKey: string
	log?: SeedLog
	now?: () => Date
}

async function sessionFor(
	input: SeedInput,
	user: RehearsalUser,
	options: { orgSlug?: string; cookieHeader?: string } = {},
) {
	const password = await deriveRehearsalPassword({
		key: input.passwordKey,
		workerName: input.workerName,
		role: user.role,
	})
	// Default to the personal org slug so multi-org users (bob after a
	// scope-grant conversion) do not hit the consent org picker.
	return openRehearsalSession(
		input.origins.app,
		{ email: user.email, username: user.username, password },
		{
			orgSlug: options.orgSlug ?? user.username,
			cookieHeader: options.cookieHeader,
		},
	)
}

async function approveSecretHost(
	session: RehearsalSession,
	input: {
		origin: string
		name: string
		host: string
		packageId: string | null
	},
) {
	const approvalUrl = new URL(
		buildSecretHostApprovalUrl({
			baseUrl: input.origin,
			name: input.name,
			scope: input.packageId ? 'package' : 'user',
			requestedHost: input.host,
			storageContext: input.packageId
				? {
						sessionId: null,
						appId: null,
						packageId: input.packageId,
						storageId: null,
					}
				: null,
		}),
	)
	await requestOk(session, `/account/secrets.json${approvalUrl.search}`, {
		body: { action: 'approve' },
	})
}

async function connectMockIntegration(
	session: RehearsalSession,
	origins: RehearsalOrigins,
) {
	const mockHost = new URL(origins.mockCloudflare).host
	const tokenUrl = `${origins.mockCloudflare}/__mocks/rehearsal/oauth/token`
	const redirectUri = `${origins.app}/connect/oauth`
	const app = {
		provider: integrationName,
		authorizeUrl: `${origins.mockCloudflare}/__mocks/rehearsal/oauth/authorize`,
		tokenUrl,
		apiBaseUrl: origins.mockCloudflare,
		flow: 'confidential',
		clientId: 'rehearsal-client',
		scopeSeparator: ' ',
	}
	await requestOk(session, '/account/secrets.json', {
		body: {
			action: 'save_oauth_app',
			...app,
			clientSecret: 'rehearsal-client-secret',
		},
	})
	const exchange = readRecord(
		await requestOk(session, '/account/secrets.json', {
			body: {
				action: 'oauth_exchange',
				tokenUrl,
				params: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: app.clientId,
					code: `rehearsal-code-${crypto.randomUUID()}`,
					redirect_uri: redirectUri,
				}).toString(),
				flow: app.flow,
				provider: integrationName,
				allowedHosts: [mockHost],
			},
		}),
		'oauth_exchange',
	)
	if (typeof exchange.access_token !== 'string') {
		throw new Error(
			`oauth_exchange returned no access_token: ${JSON.stringify(exchange)}`,
		)
	}
	const connected = readRecord(
		await requestOk(session, '/account/secrets.json', {
			body: {
				action: 'connect_oauth',
				...app,
				callbackUrl: `${redirectUri}?code=rehearsal&state=rehearsal`,
				scopes: ['rehearsal.read'],
				allowedHosts: [mockHost],
				tokenPayload: exchange,
			},
		}),
		'connect_oauth',
	)
	if (connected.accessTokenSaved !== true) {
		throw new Error(
			`connect_oauth did not save an access token: ${JSON.stringify(connected)}`,
		)
	}
}

async function mintTokens(
	session: RehearsalSession,
	origins: RehearsalOrigins,
	label: string,
) {
	const cliToken = await mintCliToken(
		session,
		origins,
		`rehearsal-cli-${label}`,
		{
			lifetime: 'long',
		},
	)
	const created = await postJson(
		`${origins.api}/v1/tokens`,
		{
			name: `rehearsal-every-scope-${label}`,
			scopes: apiTokenScopes,
			lifetime: 'long',
		},
		{ Authorization: `Bearer ${cliToken}` },
	)
	if (created.status !== 200 && created.status !== 201) {
		throw new Error(describeFailure('/v1/tokens', created))
	}
	return {
		cliToken,
		everyScopeToken: readStringAt(created.body, ['token'], 'tokenCreate'),
	}
}

async function seedPersonData(
	input: SeedInput,
	session: RehearsalSession,
	user: RehearsalUser,
	stableUserId: string,
): Promise<SeededPerson> {
	const log = input.log ?? (() => {})
	const echoUrl = `${input.origins.mockCloudflare}/__mocks/rehearsal/echo`
	const mockHost = new URL(input.origins.mockCloudflare).host

	const userSecretValue = randomSecretValue()
	await callCapability(session, 'secretSet', {
		name: userSecretName,
		value: userSecretValue,
		scope: 'user',
		description: 'Rehearsal user-level secret',
	})
	await approveSecretHost(session, {
		origin: input.origins.app,
		name: userSecretName,
		host: mockHost,
		packageId: null,
	})

	for (const memory of rehearsalMemories) {
		await callCapability(session, 'metaMemoryUpsert', {
			...memory,
			verified_by_agent: true,
		})
	}

	const saved = await callCapability(session, 'packageSave', {
		files: personalPackageFiles({
			username: user.username,
			echoUrl,
		}),
	})
	const packageId = readStringAt(saved, ['package_id'], 'packageSave')
	const packageName = `@${user.username}/${personalPackageLeaf}`

	const packageSecretValue = randomSecretValue()
	await session.execute(
		packageExportModule(`kody:${packageName}/set-package-secret`),
		{
			value: packageSecretValue,
		},
	)
	await approveSecretHost(session, {
		origin: input.origins.app,
		name: packageSecretName,
		host: mockHost,
		packageId,
	})

	const minted = await callCapability(session, 'webhookUrlMint', {
		packageId,
		webhookName: 'inbound',
	})
	const jobs = readRecord(
		await callCapability(session, 'jobList', {}),
		'jobList',
	)
	const jobRows = (Array.isArray(jobs.jobs) ? jobs.jobs : []) as Array<
		Record<string, unknown>
	>
	const jobIds = jobRows.flatMap((job) =>
		typeof job.id === 'string' ? [job.id] : [],
	)
	const dailyDigest = jobRows.find((job) =>
		JSON.stringify(job).includes('daily-digest'),
	)
	if (typeof dailyDigest?.id !== 'string') {
		throw new Error(
			`${user.role}: expected the daily-digest package job, got ${JSON.stringify(jobs)}`,
		)
	}
	await callCapability(session, 'jobRunNow', { id: dailyDigest.id })

	await connectMockIntegration(session, input.origins)
	const integrationProof = readRecord(
		await session.execute(integrationProofModule(echoUrl)),
		'integration proof',
	)
	if (integrationProof.bearerSent !== true) {
		throw new Error(
			`${user.role}: integration call did not send a bearer token: ${JSON.stringify(integrationProof)}`,
		)
	}

	const userProof = readRecord(
		await session.execute(userSecretProofModule(echoUrl)),
		'user secret proof',
	)
	const packageProof = readRecord(
		await session.execute(
			packageExportModule(`kody:${packageName}/secret-proof`),
		),
		'package secret proof',
	)
	const expectedUserHash = await sha256Hex(userSecretValue)
	const expectedPackageHash = await sha256Hex(packageSecretValue)
	if (userProof.sha256 !== expectedUserHash) {
		throw new Error(
			`${user.role}: user secret proof mismatch ${JSON.stringify(userProof)}`,
		)
	}
	if (packageProof.sha256 !== expectedPackageHash) {
		throw new Error(
			`${user.role}: package secret proof mismatch ${JSON.stringify(packageProof)}`,
		)
	}
	log(
		`  ${user.role}: secrets, memories, package, jobs, webhook, integration ok`,
	)
	return {
		role: user.role,
		email: user.email,
		username: user.username,
		stableUserId,
		origin: user.origin,
		packageId,
		packageName,
		webhookHandle: readStringAt(
			minted,
			['webhook', 'handle'],
			'webhookUrlMint',
		),
		jobIds,
		userSecretSha256: expectedUserHash,
		packageSecretSha256: expectedPackageHash,
	}
}

/** The person roster. A complete seed has all of these. */
export const rehearsalSeedEmails = rehearsalUsers.map((user) => user.email)

const rehearsalSeedRosterSize = rehearsalSeedEmails.length

export type RehearsalSeedState = 'empty' | 'partial' | 'complete'

export type RehearsalSeedStatus = {
	workerName: string
	state: RehearsalSeedState
	count: number
	expected: number
	carolAutoRefill: boolean
	app: RehearsalDatabase
}

export function classifyRehearsalSeed(input: {
	count: number
	carolAutoRefill: boolean
}): RehearsalSeedState {
	if (!Number.isFinite(input.count) || input.count <= 0) return 'empty'
	if (input.count < rehearsalSeedRosterSize) return 'partial'
	// Carol's auto-refill settings are the last durable APP_DB write in
	// seedRehearsal. Every account can exist earlier; that is still an
	// incomplete seed.
	if (input.carolAutoRefill) return 'complete'
	return 'partial'
}

export async function rehearsalSeedStatus(
	client: CloudflareClient,
	workerName: string,
): Promise<RehearsalSeedStatus> {
	const app = (await resolveRehearsalDatabases(client, workerName)).find(
		(database) => database.role === 'app',
	)
	if (!app) throw new Error('No app database for this preview.')
	const emails = rehearsalSeedEmails.map((email) => `'${email}'`).join(', ')
	const carolEmail = rehearsalUser('carol').email
	const rows = await queryD1<{ n: number; carol_auto_refill: number | null }>(
		client,
		app.uuid,
		`SELECT (SELECT COUNT(*) FROM users WHERE email IN (${emails})) AS n, (SELECT w.auto_refill_enabled FROM credit_wallets w INNER JOIN users u ON u.stable_user_id = w.user_id WHERE u.email = '${carolEmail}') AS carol_auto_refill`,
	)
	const count = Number(rows[0]?.n ?? 0)
	const carolAutoRefill = Number(rows[0]?.carol_auto_refill ?? 0) === 1
	return {
		workerName,
		state: classifyRehearsalSeed({ count, carolAutoRefill }),
		count,
		expected: rehearsalSeedRosterSize,
		carolAutoRefill,
		app,
	}
}

export async function assertNotSeeded(
	client: CloudflareClient,
	workerName: string,
) {
	const status = await rehearsalSeedStatus(client, workerName)
	switch (status.state) {
		case 'empty':
			return status.app
		case 'complete':
			throw new Error(
				`${workerName} already has the full rehearsal roster (${status.count}/${status.expected}). Restore the last successful seed run's pre-seed D1 snapshot (action restore) or use a fresh branch preview, then seed again.`,
			)
		case 'partial':
			throw new Error(
				`${workerName} has a partial rehearsal roster (${status.count}/${status.expected}). Restore the last successful seed run's pre-seed D1 snapshot (action restore), then seed again.`,
			)
		default: {
			const _exhaustive: never = status.state
			throw new Error(`Unknown rehearsal seed state: ${_exhaustive}`)
		}
	}
}

/**
 * Seed §12.2 through the preview's real paths. The only direct D1 writes are
 * the seed-path users (the same SQL `seed-test-data.ts` runs, giving legacy
 * `sha256(email)` ids) and carol's auto-refill settings (no Stripe mock on
 * previews, so the settings route refuses non-Stripe customers).
 */
export async function seedRehearsal(
	input: SeedInput,
): Promise<{ manifest: SeedManifest; credentials: SeedCredentials }> {
	const log = input.log ?? (() => {})
	const now = input.now ?? (() => new Date())
	const appDb = await assertNotSeeded(input.client, input.workerName)

	const passwords = new Map<RehearsalUser['role'], string>()
	for (const user of rehearsalUsers) {
		passwords.set(
			user.role,
			await deriveRehearsalPassword({
				key: input.passwordKey,
				workerName: input.workerName,
				role: user.role,
			}),
		)
	}

	log('Creating seed-path users (legacy sha256(email) ids)...')
	const seedSql: Array<string> = []
	for (const user of rehearsalUsers.filter(
		(entry) => entry.origin === 'seed-sql',
	)) {
		seedSql.push(
			buildSeedUserSql({
				email: user.email,
				username: user.username,
				passwordHash: await createPasswordHash(passwords.get(user.role) ?? ''),
				admin: user.siteAdmin,
			}),
		)
	}
	await queryD1(input.client, appDb.uuid, seedSql.join('\n'))

	const admin = await sessionFor(input, rehearsalUser('admin'))
	const sessions: Array<RehearsalSession> = [admin]
	try {
		const stableIds = new Map<RehearsalUser['role'], string>()
		for (const role of ['admin', 'alice', 'bob'] as const) {
			const found = await callCapability(admin, 'adminUserGet', {
				email: rehearsalUser(role).email,
			})
			stableIds.set(
				role,
				readStringAt(found, ['user', 'stableUserId'], 'adminUserGet'),
			)
		}

		log('Creating carol through adminUserCreate + password setup link...')
		const carol = rehearsalUser('carol')
		const created = await callCapability(admin, 'adminUserCreate', {
			email: carol.email,
			username: carol.username,
		})
		stableIds.set(
			'carol',
			readStringAt(created, ['createdUser', 'stableUserId'], 'adminUserCreate'),
		)
		const setupToken = new URL(
			readStringAt(created, ['createdUser', 'setupLink'], 'adminUserCreate'),
		).searchParams.get('token')
		if (!setupToken) {
			throw new Error('adminUserCreate setupLink has no token parameter.')
		}
		const confirmed = await postJson(
			`${input.origins.app}/password-reset/confirm`,
			{
				token: setupToken,
				password: passwords.get('carol'),
			},
		)
		if (confirmed.status >= 300) {
			throw new Error(describeFailure('/password-reset/confirm', confirmed))
		}

		log('Creating dave through /auth signup + adminUserVerify...')
		const dave = rehearsalUser('dave')
		const signup = await postJson(`${input.origins.app}/auth`, {
			email: dave.email,
			username: dave.username,
			password: passwords.get('dave'),
			mode: 'signup',
		})
		if (signup.status >= 300)
			throw new Error(describeFailure('/auth signup', signup))
		await callCapability(admin, 'adminUserVerify', {
			email: dave.email,
			action: 'mark_verified',
		})
		const daveRecord = await callCapability(admin, 'adminUserGet', {
			email: dave.email,
		})
		stableIds.set(
			'dave',
			readStringAt(daveRecord, ['user', 'stableUserId'], 'adminUserGet'),
		)

		log('Site-admin setup: plans and credits...')
		for (const role of ['alice', 'carol'] as const) {
			await callCapability(admin, 'adminUserUpdate', {
				email: rehearsalUser(role).email,
				plan: 'pro',
			})
		}
		for (const [role, amountCents] of [
			['alice', 2500],
			['bob', 500],
			['carol', 1500],
		] as const) {
			await callCapability(admin, 'adminCreditGrant', {
				email: rehearsalUser(role).email,
				amountCents,
				note: 'Preview migration rehearsal seed',
			})
		}

		const personSessions = new Map<RehearsalUser['role'], RehearsalSession>()
		const people: Array<SeededPerson> = []
		const tokens = new Map<
			RehearsalUser['role'],
			{ cliToken: string; everyScopeToken: string }
		>()
		for (const role of ['alice', 'bob', 'carol', 'dave'] as const) {
			const user = rehearsalUser(role)
			log(`Seeding ${role} (${user.origin})...`)
			const session = await sessionFor(input, user)
			sessions.push(session)
			personSessions.set(role, session)
			people.push(
				await seedPersonData(input, session, user, stableIds.get(role) ?? ''),
			)
			tokens.set(role, await mintTokens(session, input.origins, role))
		}
		tokens.set('admin', await mintTokens(admin, input.origins, 'admin'))

		log(
			'Grants: alice grants carol Use on her package, secret, and integration; carol invites alice (pending)...',
		)
		const alice = personSessions.get('alice')
		const carolSession = personSessions.get('carol')
		if (!alice || !carolSession)
			throw new Error('Missing alice/carol sessions.')
		const alicePackage = people.find((person) => person.role === 'alice')
		const carolPackage = people.find((person) => person.role === 'carol')
		const useGrant = await callCapability(alice, 'accessGrant', {
			resource_type: 'package',
			resource_id: alicePackage?.packageId,
			subject_type: 'user',
			username: rehearsalUser('carol').username,
			preset: 'use',
		})
		const useGrantId = readStringAt(useGrant, ['grant', 'id'], 'accessGrant')
		const carolInAliceOrg = await sessionFor(input, rehearsalUser('carol'), {
			orgSlug: rehearsalUser('alice').username,
			cookieHeader: carolSession.cookieHeader,
		})
		sessions.push(carolInAliceOrg)
		const granteeRun = readRecord(
			await carolInAliceOrg.execute(
				packageExportModule(`kody:${alicePackage?.packageName}/ping`),
			),
			"carol's execute of alice's package through her Use grant",
		)
		if (granteeRun.pong !== true) {
			throw new Error(
				`carol could not run alice's package: ${JSON.stringify(granteeRun)}`,
			)
		}
		for (const credentialId of await aliceCredentialIds(alice)) {
			await callCapability(alice, 'accessGrant', {
				resource_type: 'credential',
				resource_id: credentialId,
				subject_type: 'user',
				username: rehearsalUser('carol').username,
				preset: 'use',
			})
		}
		await credentialGranteeProofs({
			grantee: carolInAliceOrg,
			owner: alice,
			echoUrl: `${input.origins.mockCloudflare}/__mocks/rehearsal/echo`,
			ownerSecretSha256: alicePackage?.userSecretSha256 ?? null,
		})
		const pending = await callCapability(carolSession, 'inviteCreate', {
			kind: 'grant',
			username: rehearsalUser('alice').username,
			resource_type: 'package',
			resource_id: carolPackage?.packageId,
			preset: 'use',
		})
		const pendingInviteId = readStringAt(
			pending,
			['invite', 'id'],
			'inviteCreate',
		)

		log(
			`Org: bob creates @${rehearsalOrg.slug} and publishes public, private, and hidden packages...`,
		)
		const bob = personSessions.get(rehearsalOrg.owner)
		const daveSession = personSessions.get('dave')
		if (!bob || !daveSession) throw new Error('Missing bob/dave sessions.')
		const createdOrg = await callCapability(bob, 'orgCreate', {
			slug: rehearsalOrg.slug,
			display_name: rehearsalOrg.displayName,
		})
		const orgId = readStringAt(createdOrg, ['org', 'id'], 'orgCreate')
		const bobInOrg = await sessionFor(
			input,
			rehearsalUser(rehearsalOrg.owner),
			{
				orgSlug: rehearsalOrg.slug,
				cookieHeader: bob.cookieHeader,
			},
		)
		sessions.push(bobInOrg)
		const orgSaved: SeedManifest['org']['packages'] = []
		let listingId = ''
		for (const entry of orgPackages) {
			const savedOrgPackage = await callCapability(bobInOrg, 'packageSave', {
				files: orgPackageFiles({
					scope: rehearsalOrg.slug,
					leaf: entry.leaf,
					description: entry.description,
				}),
			})
			const packageId = readStringAt(
				savedOrgPackage,
				['package_id'],
				'packageSave',
			)
			orgSaved.push({
				leaf: entry.leaf,
				visibility: entry.visibility,
				packageId,
			})
			switch (entry.visibility) {
				case 'public': {
					const listing = await callCapability(bobInOrg, 'communityPublish', {
						package_id: packageId,
					})
					listingId = readStringAt(listing, ['listing_id'], 'communityPublish')
					break
				}
				case 'hidden':
					await callCapability(bobInOrg, 'packageUpdate', {
						package_id: packageId,
						changes: { hidden: true },
					})
					break
				case 'private':
					break
				default: {
					const unreachable: never = entry.visibility
					throw new Error(`Unknown visibility ${String(unreachable)}`)
				}
			}
		}
		const fork = await callCapability(daveSession, 'communityFork', {
			listing_id: listingId,
		})
		const forkPackageId = readStringAt(fork, ['package_id'], 'communityFork')

		log(
			'Billing: carol auto-refill settings (direct D1 write; no Stripe mock)...',
		)
		await queryD1(
			input.client,
			appDb.uuid,
			`UPDATE credit_wallets SET auto_refill_enabled = 1, auto_refill_threshold_cents = 500, auto_refill_amount_cents = 2000, auto_refill_monthly_cap_cents = 10000 WHERE user_id = '${stableIds.get('carol')}'`,
		)

		const credentials: SeedCredentials = {
			version: 1,
			workerName: input.workerName,
			origins: input.origins,
			users: rehearsalUsers.map((user) => ({
				role: user.role,
				email: user.email,
				username: user.username,
				orgSlug: user.username,
				password: passwords.get(user.role) ?? '',
				cliToken: tokens.get(user.role)?.cliToken ?? '',
				everyScopeToken: tokens.get(user.role)?.everyScopeToken ?? '',
			})),
		}
		const manifest: SeedManifest = {
			version: 1,
			workerName: input.workerName,
			seededAt: now().toISOString(),
			origins: input.origins,
			people: [
				{
					role: 'admin',
					email: rehearsalUser('admin').email,
					username: rehearsalUser('admin').username,
					stableUserId: stableIds.get('admin') ?? '',
					origin: 'seed-sql',
					packageId: null,
					packageName: null,
					webhookHandle: null,
					jobIds: [],
					userSecretSha256: null,
					packageSecretSha256: null,
				},
				...people,
			],
			org: {
				id: orgId,
				slug: rehearsalOrg.slug,
				owner: rehearsalOrg.owner,
				packages: orgSaved,
				listingId,
				forkedBy: 'dave',
				forkPackageId,
			},
			grants: { useGrantId, pendingInviteId },
			autoRefill: { role: 'carol' },
		}
		return { manifest, credentials }
	} finally {
		for (const session of sessions) await session.close()
	}
}
