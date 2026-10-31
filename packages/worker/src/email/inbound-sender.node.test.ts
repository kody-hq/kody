/**
 * Inbound email runs as the verified sender (credentials plan v4, PR 9; leak
 * tests 8 and 19). Real boundaries: migrated APP_DB and AUDIT_DB, a real team
 * org with real accounts, memberships, teams and grants, the real dispatch,
 * subscription invoke and module execution, and the real credential door.
 * Only the sandbox is replaced: it resolves an org secret the way package
 * code does, through `resolveCredential` with the run's request context.
 */
import { DatabaseSync } from 'node:sqlite'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import { findCredentialIdsByLegacyName } from '#worker/credentials/credential-ids.ts'
import { attestedPackageStamp } from '#worker/credentials/package-stamp.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import { insertEnablement } from '#worker/enablements/repo.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { type PackageInvocationResponse } from '#worker/package-invocations/common.ts'
import type * as IdempotentModuleInvocation from '#worker/package-invocations/idempotent-module-invocation.ts'
import type * as ModuleArtifacts from '#worker/package-invocations/module-artifacts.ts'
import { runSavedPackageModuleOnce } from '#worker/package-invocations/module-execution.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import type * as RunKodyRegistry from '#mcp/run-kody-registry.ts'
import { classifyInboundEmailSender } from './inbound-sender.ts'
import { dispatchInboundEmailSubscriptionEvents } from './package-subscriptions.ts'

const scheduledAudits = vi.hoisted(() => [] as Array<Promise<unknown>>)

const mocks = vi.hoisted(() => ({
	ensureModuleArtifact: vi.fn(),
	runBundledModuleWithRegistry: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: (promise: Promise<unknown>) => {
		scheduledAudits.push(promise)
	},
}))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

vi.mock('./mailbox-internal-read.ts', () => ({
	listInternalEmailAttachmentsForMessage: async () => [],
}))

vi.mock(
	'#worker/package-invocations/module-artifacts.ts',
	async (importOriginal) => ({
		...(await importOriginal<typeof ModuleArtifacts>()),
		ensureModuleArtifact: mocks.ensureModuleArtifact,
	}),
)

vi.mock('#mcp/run-kody-registry.ts', async (importOriginal) => ({
	...(await importOriginal<typeof RunKodyRegistry>()),
	runBundledModuleWithRegistry: mocks.runBundledModuleWithRegistry,
}))

// The keyed ledger is storage plumbing; each run executes once, unkeyed.
vi.mock(
	'#worker/package-invocations/idempotent-module-invocation.ts',
	async (importOriginal) => ({
		...(await importOriginal<typeof IdempotentModuleInvocation>()),
		invokeSavedPackageModule: async (
			input: Parameters<typeof runSavedPackageModuleOnce>[0],
		) =>
			(
				await runSavedPackageModuleOnce({
					...input,
					idempotencyKey: null,
					invocationId: null,
				})
			).response,
	}),
)

const now = '2026-10-11T00:00:00.000Z'
const topic = 'email.message.received'
const teamSecretValue = 'team-secret-value-never-audited'

type AuditRow = {
	org_id: string
	actor_user_id: string | null
	credential_kind: string | null
	credential_id: string | null
	resource_id: string | null
	result: string
	details_json: string | null
}

type SandboxRun = {
	packageId: string
	request: RequestContext | null
	error: unknown
}

async function insertAccount(
	db: D1Database,
	input: { email: string; username: string; verified: boolean },
) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
			 VALUES (?, ?, 'test-password-hash', ?, ?)`,
		)
		.bind(
			input.username,
			input.email,
			input.verified ? now : null,
			stableUserId,
		)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId,
		username: input.username,
		createdAt: now,
	})
	return stableUserId
}

async function insertPackage(db: D1Database, orgId: string, id: string) {
	await db
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES (?, ?, ?, ?, '', ?)`,
		)
		.bind(id, orgId, `@acme/${id}`, id, `source-${id}`)
		.run()
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const auditDb = createAuditTestDb()
	const ownerId = await insertAccount(db, {
		email: 'owner@acme.example',
		username: 'owner',
		verified: true,
	})
	const beaId = await insertAccount(db, {
		email: 'bea@acme.example',
		username: 'bea',
		verified: true,
	})
	const cyId = await insertAccount(db, {
		email: 'cy@acme.example',
		username: 'cy',
		verified: false,
	})
	const deeId = await insertAccount(db, {
		email: 'dee@elsewhere.example',
		username: 'dee',
		verified: true,
	})
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: personIdFromStored(ownerId),
			audit: createTestOrgAuditWriter(),
			slug: 'quillworks',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const teamOrg = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'quillworks'`)
		.first<{ id: string }>()
	const orgId = ownerIdFromStored(teamOrg!.id)
	for (const memberId of [beaId, cyId]) {
		await db
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'member', ?)`,
			)
			.bind(orgId, memberId, now)
			.run()
	}
	await db
		.prepare(
			`INSERT INTO teams (id, org_id, slug, name, created_at, updated_at)
			 VALUES ('team-ops', ?, 'ops', 'Ops', ?, ?)`,
		)
		.bind(orgId, now, now)
		.run()
	await db
		.prepare(
			`INSERT INTO team_members (team_id, user_id, created_at)
			 VALUES ('team-ops', ?, ?)`,
		)
		.bind(cyId, now)
		.run()

	// pkg-shared: Bea holds Use. pkg-ops: granted to a team Bea is not in.
	// pkg-private: no grant. pkg-bea-personal: Bea's own org, not the inbox's.
	for (const id of ['pkg-shared', 'pkg-ops', 'pkg-private']) {
		await insertPackage(db, orgId, id)
	}
	await insertPackage(db, beaId, 'pkg-bea-personal')
	for (const [packageId, subject] of [
		['pkg-shared', { type: 'user', id: beaId }],
		['pkg-ops', { type: 'team', id: 'team-ops' }],
	] as const) {
		await upsertGrant({
			db,
			orgId,
			resourceType: 'package',
			resourceId: packageId,
			subject,
			preset: 'use',
			permissions: null,
			createdByUserId: ownerId,
			audit: createTestOrgAuditWriter(),
		})
	}

	// Each email subscription is a member sender rule for the person who
	// turned it on. Unmatched senders run nothing.
	const enablementIds = new Map<string, string>()
	for (const [packageId, enablerUserId] of [
		['pkg-shared', beaId],
		['pkg-shared', ownerId],
		['pkg-ops', ownerId],
		['pkg-private', ownerId],
	] as const) {
		const enablement = await insertEnablement({
			db,
			enablement: {
				orgId,
				packageId,
				triggerKind: 'subscription',
				triggerName: topic,
				instanceId: packageId,
				enablerUserId: personIdFromStored(enablerUserId),
				origin: 'enabled',
				senderKind: 'member',
				senderValue: enablerUserId,
			},
		})
		enablementIds.set(`${packageId}:${enablerUserId}`, enablement.id)
	}

	const env = {
		APP_DB: db,
		AUDIT_DB: auditDb,
		APP_BASE_URL: 'https://kody.example',
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	await saveSecret({
		env,
		userId: orgId,
		scope: 'user',
		name: 'teamToken',
		value: teamSecretValue,
		audit: null,
	})
	// Bea may use the team secret.
	const [teamTokenId] = await findCredentialIdsByLegacyName(db, orgId, {
		type: 'secret',
		name: 'teamToken',
	})
	await upsertGrant({
		db,
		orgId,
		resourceType: 'credential',
		resourceId: teamTokenId ?? '',
		family: 'secret',
		subject: { type: 'user', id: beaId },
		preset: 'use',
		permissions: null,
		createdByUserId: ownerId,
		audit: createTestOrgAuditWriter(),
	})

	mocks.loadPackageManifestBySourceId.mockImplementation(
		async ({ sourceId }: { sourceId: string }) => ({
			manifest: {
				name: sourceId,
				kody: {
					id: sourceId,
					description: sourceId,
					subscriptions: { [topic]: { handler: './src/handler.ts' } },
				},
			},
		}),
	)
	mocks.ensureModuleArtifact.mockImplementation(
		async ({
			savedPackage,
		}: {
			savedPackage: {
				id: string
				userId: string
				kodyId: string
				sourceId: string
			}
		}) => ({
			artifact: {
				version: 1,
				kind: 'module',
				artifactName: `subscription:${topic}`,
				sourceId: savedPackage.sourceId,
				publishedCommit: 'commit-1',
				entryPoint: 'src/handler.ts',
				mainModule: 'dist/subscription.js',
				modules: { 'dist/subscription.js': 'export default () => null' },
				dependencies: [],
				packageContext: {
					packageId: savedPackage.id,
					kodyId: savedPackage.kodyId,
					sourceId: savedPackage.sourceId,
				},
				createdAt: now,
			},
			source: {
				id: savedPackage.sourceId,
				user_id: savedPackage.userId,
				entity_kind: 'package',
				entity_id: savedPackage.id,
				repo_id: `repo-${savedPackage.id}`,
				published_commit: 'commit-1',
				indexed_commit: null,
				manifest_path: 'package.json',
				source_root: '/',
				created_at: now,
				updated_at: now,
			},
		}),
	)

	const runs: Array<SandboxRun> = []
	let beforeResolve: () => Promise<void> = async () => {}
	mocks.runBundledModuleWithRegistry.mockImplementation(
		async (
			_env: Env,
			callerContext: McpCallerContext,
			_bundle: unknown,
			_params: unknown,
			options: { packageContext: { packageId: string } },
		) => {
			const packageId = options.packageContext.packageId
			const run: SandboxRun = {
				packageId,
				request: callerContext.request,
				error: null,
			}
			runs.push(run)
			await beforeResolve()
			try {
				await resolveCredential({
					env,
					orgId,
					actor: callerContext.request,
					packageStamp: attestedPackageStamp(packageId),
					baseUrl: 'https://kody.example',
					credential: {
						use: 'secret',
						name: 'teamToken',
						storageContext: {
							sessionId: null,
							appId: packageId,
							packageId,
						},
					},
				})
				return { result: { ok: true }, logs: [] }
			} catch (error) {
				run.error = error
				return { error, logs: [] }
			}
		},
	)

	const sendEmail = (input: {
		from: string
		envelopeFrom?: string
		authResults: string | null
	}) =>
		dispatchInboundEmailSubscriptionEvents({
			env,
			userId: orgId,
			message: {
				id: `message-${crypto.randomUUID()}`,
				userId: orgId,
				inboxId: 'inbox-acme',
				fromAddress: input.from,
				envelopeFrom: input.envelopeFrom ?? input.from,
				toAddresses: ['team@acme.kody.example'],
				ccAddresses: [],
				replyToAddresses: [],
				subject: 'Hello',
				messageIdHeader: null,
				inReplyToHeader: null,
				references: [],
				authResults: input.authResults,
				processingStatus: 'stored',
				classification: 'accepted',
				classificationReason: null,
				receivedAt: now,
				createdAt: now,
			} as never,
		}) as Promise<Array<PackageInvocationResponse | null>>

	const auditRows = async () => {
		await Promise.all(scheduledAudits.splice(0))
		const { results } = await auditDb
			.prepare(
				`SELECT * FROM org_audit_events
				 WHERE action = 'credential.resolve' ORDER BY rowid`,
			)
			.all<AuditRow>()
		return results
	}

	return {
		db,
		orgId,
		teamTokenId,
		enablementId: (packageId: string, enablerUserId: string) =>
			enablementIds.get(`${packageId}:${enablerUserId}`),
		ownerId,
		beaId,
		cyId,
		deeId,
		runs,
		sendEmail,
		auditRows,
		setBeforeResolve(fn: () => Promise<void>) {
			beforeResolve = fn
		},
	}
}

const dmarcPass = 'mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass'

function details(row: AuditRow | undefined) {
	return JSON.parse(row?.details_json ?? 'null') as Record<string, unknown>
}

function expectNoValueIn(rows: Array<AuditRow>) {
	expect(JSON.stringify(rows)).not.toContain(teamSecretValue)
}

test('a member email runs as that member, only their packages, audited under them', async () => {
	const t = await setup()

	await t.sendEmail({ from: 'Bea <bea@acme.example>', authResults: dmarcPass })

	// Leak test 19: never a private package, another team's grant, or a
	// package in another org (Bea's personal org).
	expect(t.runs.map((run) => run.packageId)).toEqual(['pkg-shared'])
	const [run] = t.runs
	expect(run?.error).toBeNull()
	const enablementId = t.enablementId('pkg-shared', t.beaId)
	expect(run?.request).toEqual({
		org: { id: t.orgId, slug: 'quillworks' },
		actor: { userId: t.beaId, username: 'bea' },
		attribution: { kind: 'user', userId: t.beaId },
		credential: {
			kind: 'inbound-email',
			id: enablementId,
			orgId: t.orgId,
			scopes: null,
		},
		membership: { role: 'member' },
	})

	const rows = await t.auditRows()
	expect(rows).toHaveLength(1)
	expect(rows[0]).toMatchObject({
		org_id: t.orgId,
		actor_user_id: t.beaId,
		credential_kind: 'inbound-email',
		credential_id: enablementId,
		resource_id: t.teamTokenId,
		result: 'success',
	})
	expect(details(rows[0])).toMatchObject({
		actorKind: 'person',
		packageStampKind: 'attested',
		packageId: 'pkg-shared',
	})
	expectNoValueIn(rows)
})

test('an authenticated sender with no matching rule runs nothing', async () => {
	const t = await setup()

	for (const from of [
		'receipts@shop.example',
		// A Kody account outside the org is still a non-member.
		'dee@elsewhere.example',
	]) {
		t.runs.splice(0)
		await t.sendEmail({ from, authResults: 'mx; spf=pass; dkim=none' })
		expect(t.runs).toEqual([])
	}
	expect(await t.auditRows()).toEqual([])
})

test('a migrated any_authenticated catch-all runs the enabler for authenticated mail', async () => {
	const t = await setup()
	await t.db
		.prepare(
			`UPDATE enablements
			 SET sender_kind = 'any_authenticated', sender_value = NULL
			 WHERE org_id = ? AND enabler_user_id = ?`,
		)
		.bind(t.orgId, t.ownerId)
		.run()

	await t.sendEmail({
		from: 'receipts@shop.example',
		authResults: 'mx; spf=pass; dkim=none',
	})

	expect(t.runs.map((run) => run.packageId).sort()).toEqual([
		'pkg-ops',
		'pkg-private',
		'pkg-shared',
	])
	for (const run of t.runs) {
		expect(run.error).toBeNull()
		expect(run.request).toMatchObject({
			org: { id: t.orgId },
			actor: { userId: t.ownerId },
			membership: { role: 'owner' },
			attribution: { kind: 'user', userId: t.ownerId },
			credential: {
				kind: 'inbound-email',
				id: t.enablementId(run.packageId, t.ownerId),
			},
		})
	}
	// DKIM-only still does not match the catch-all.
	consoleWarn.mockImplementation(() => {})
	t.runs.splice(0)
	await t.sendEmail({
		from: 'receipts@shop.example',
		authResults: 'mx; spf=none; dkim=pass',
	})
	expect(t.runs).toEqual([])
	expect(consoleWarn).toHaveBeenCalledWith(
		'inbound-email-sender-unverified',
		expect.objectContaining({ outcome: 'no package subscriptions ran' }),
	)
})

test('leak test 8: an unverified sender or a spoofed member address runs nothing', async () => {
	const t = await setup()
	consoleWarn.mockImplementation(() => {})

	const cases = [
		{
			label: 'member address with no authentication results',
			email: { from: 'bea@acme.example', authResults: null },
		},
		{
			label: 'member address, SPF and DKIM pass for an unrelated domain',
			email: {
				from: 'bea@acme.example',
				envelopeFrom: 'bounce@attacker.example',
				authResults: 'mx; spf=pass; dkim=pass',
			},
		},
		{
			label:
				'member address, unaligned DKIM pass with a forged member envelope',
			email: {
				from: 'bea@acme.example',
				envelopeFrom: 'bea@acme.example',
				authResults: 'mx; spf=fail; dkim=pass',
			},
		},
		{
			label: 'member address that failed DMARC',
			email: {
				from: 'bea@acme.example',
				authResults: 'mx; spf=pass; dkim=fail; dmarc=fail',
			},
		},
		{
			label: 'member whose account email is not verified',
			email: { from: 'cy@acme.example', authResults: dmarcPass },
		},
		{
			label: 'non-member that failed SPF without DKIM',
			email: {
				from: 'receipts@shop.example',
				authResults: 'mx; spf=fail; dkim=none',
			},
		},
		{
			label: 'external sender with DKIM pass only',
			email: {
				from: 'receipts@shop.example',
				envelopeFrom: 'receipts@shop.example',
				authResults: 'mx; spf=none; dkim=pass',
			},
		},
	]
	for (const { label, email } of cases) {
		consoleWarn.mockClear()
		await expect(t.sendEmail(email), label).resolves.toEqual([])
		expect(consoleWarn, label).toHaveBeenCalledWith(
			'inbound-email-sender-unverified',
			expect.objectContaining({
				orgId: t.orgId,
				inboxId: 'inbox-acme',
				outcome: 'no package subscriptions ran',
			}),
		)
	}
	expect(t.runs).toEqual([])
	expect(await t.auditRows()).toEqual([])
})

test('a member who lost org access is denied at resolve time, with no fallback', async () => {
	const t = await setup()
	// Bea loses all access between dispatch and the credential read. A live
	// grant alone would keep her in as an outside collaborator.
	t.setBeforeResolve(async () => {
		await t.db
			.prepare(
				`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ? AND user_id = ?`,
			)
			.bind(now, t.orgId, t.beaId)
			.run()
		await t.db
			.prepare(
				`UPDATE grants SET deleted_at = ?
				 WHERE org_id = ? AND subject_type = 'user' AND subject_id = ?`,
			)
			.bind(now, t.orgId, t.beaId)
			.run()
	})

	const [response] = await t.sendEmail({
		from: 'bea@acme.example',
		authResults: dmarcPass,
	})

	expect(t.runs).toHaveLength(1)
	expect(t.runs[0]?.request?.actor?.userId).toBe(t.beaId)
	expect(t.runs[0]?.error).toMatchObject({
		name: 'AuthorizationError',
		code: 'wrong_org',
	})
	expect(response?.status).toBeGreaterThanOrEqual(400)

	const rows = await t.auditRows()
	expect(rows.map((row) => [row.actor_user_id, row.result])).toEqual([
		[t.beaId, 'denied'],
	])
	expect(details(rows[0])).toMatchObject({ reason: 'wrong_org' })
	expectNoValueIn(rows)

	// Once removed, Bea is a non-member. Her member rule no longer matches,
	// and nothing falls back to the Owner.
	t.setBeforeResolve(async () => {})
	t.runs.splice(0)
	await t.sendEmail({ from: 'bea@acme.example', authResults: dmarcPass })
	expect(t.runs).toEqual([])
})

test('classification reads live account state for the inbox org', async () => {
	const t = await setup()
	const classify = (from: string, orgId: OwnerId = t.orgId) =>
		classifyInboundEmailSender({
			db: t.db,
			orgId,
			message: {
				fromAddress: from,
				envelopeFrom: from,
				authResults: dmarcPass,
			},
		})

	await expect(classify('BEA@acme.example')).resolves.toMatchObject({
		kind: 'member',
		actor: { userId: t.beaId },
		role: 'member',
	})
	// Without DMARC, SPF pass for an envelope in the From domain is aligned.
	await expect(
		classifyInboundEmailSender({
			db: t.db,
			orgId: t.orgId,
			message: {
				fromAddress: 'bea@acme.example',
				envelopeFrom: 'bounce@acme.example',
				authResults: 'mx; spf=pass; dkim=none',
			},
		}),
	).resolves.toMatchObject({ kind: 'member', actor: { userId: t.beaId } })
	// Bea is the Owner of her personal org, so mail to its inbox is hers too.
	await expect(
		classify('bea@acme.example', ownerIdFromStored(t.beaId)),
	).resolves.toMatchObject({ kind: 'member', role: 'owner' })

	await t.db
		.prepare(`UPDATE users SET suspended_at = ? WHERE stable_user_id = ?`)
		.bind(now, t.beaId)
		.run()
	await expect(classify('bea@acme.example')).resolves.toMatchObject({
		kind: 'unverified',
	})
	await expect(
		classifyInboundEmailSender({
			db: t.db,
			orgId: t.orgId,
			message: {
				fromAddress: null,
				envelopeFrom: null,
				authResults: dmarcPass,
			},
		}),
	).resolves.toMatchObject({ kind: 'unverified' })

	// DKIM pass alone does not authenticate From, so an external sender is
	// unverified and must not be classified as the inbox owner.
	await expect(
		classifyInboundEmailSender({
			db: t.db,
			orgId: t.orgId,
			message: {
				fromAddress: 'receipts@shop.example',
				envelopeFrom: 'receipts@shop.example',
				authResults: 'mx; spf=none; dkim=pass',
			},
		}),
	).resolves.toMatchObject({ kind: 'unverified' })
	await expect(
		classifyInboundEmailSender({
			db: t.db,
			orgId: t.orgId,
			message: {
				fromAddress: 'receipts@shop.example',
				envelopeFrom: 'bounce@shop.example',
				authResults: 'mx; spf=pass; dkim=none',
			},
		}),
	).resolves.toMatchObject({ kind: 'inbox-owner' })
})
