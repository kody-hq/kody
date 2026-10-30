import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
/**
 * Enablement leak tests (credentials plan v4, PR 7b). Real boundaries: a
 * migrated APP_DB and AUDIT_DB, a real team org moved to enablements, real
 * accounts, memberships and grants, real enablement writes, the real run
 * gate, the real email, webhook and subscription dispatch, module execution,
 * and the real credential door. Only the sandbox is replaced: it resolves an
 * org secret the way package code does, through `resolveCredential` with the
 * run's request context.
 */
import { DatabaseSync } from 'node:sqlite'
import type * as CloudflareWorkers from 'cloudflare:workers'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	type OrgRole,
	type RequestContext,
} from '@kody-internal/shared/request-context.ts'
import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import { findCredentialIdsByLegacyName } from '#worker/credentials/credential-ids.ts'
import { attestedPackageStamp } from '#worker/credentials/package-stamp.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import { dispatchInboundEmailSubscriptionEvents } from '#worker/email/package-subscriptions.ts'
import { buildPackageJobId } from '#worker/jobs/package-job-id.ts'
import { upsertGrant } from '#worker/orgs/access-writes.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { type PackageInvocationResponse } from '#worker/package-invocations/common.ts'
import type * as IdempotentModuleInvocation from '#worker/package-invocations/idempotent-module-invocation.ts'
import type * as ModuleArtifacts from '#worker/package-invocations/module-artifacts.ts'
import { runSavedPackageModuleOnce } from '#worker/package-invocations/module-execution.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	deriveRequestContext,
	inheritRequest,
	type RequestSource,
} from '#worker/request-context/request-context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleInfo } from '#worker/test-support/console-spies.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { dispatchWebhookInvocation } from '#worker/webhooks/delivery.ts'
import { orgMemberUpdateCapability } from '#mcp/capabilities/access/org-members.ts'
import { adminCreditGrantCapability } from '#mcp/capabilities/admin/admin-credit-grant.ts'
import { adminFeatureFlagSetCapability } from '#mcp/capabilities/admin/admin-feature-flag-set.ts'
import { adminUserUpdateCapability } from '#mcp/capabilities/admin/admin-user-update.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { deleteSecret, saveSecret } from '#mcp/secrets/service.ts'
import {
	collectWaitingSignals,
	deriveWaitingItemsForStableUser,
} from '#mcp/waiting/derive-waiting.ts'
import { buildWaitingItems } from '#universal/waiting.ts'
import type * as RunKodyRegistry from '#mcp/run-kody-registry.ts'
import {
	buildInsertEnablementStatement,
	buildInsertWebhookEnablementStatement,
	getEnablementById,
	insertEnablement,
} from './repo.ts'
import { type EnablementAudience, planEnablementRuns } from './run-gate.ts'
import {
	enableTriggerForCaller,
	runNewEnablementPlans,
	TriggerEnablementError,
} from './service.ts'

const scheduledAudits = vi.hoisted(() => [] as Array<Promise<unknown>>)

const mocks = vi.hoisted(() => ({
	ensureModuleArtifact: vi.fn(),
	runBundledModuleWithRegistry: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof CloudflareWorkers>()),
	waitUntil: (promise: Promise<unknown>) => {
		scheduledAudits.push(promise)
	},
}))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

vi.mock('#worker/email/mailbox-internal-read.ts', () => ({
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
const emailTopic = 'email.message.received'
const eventTopic = 'acme.thing.happened'
const jobName = 'nightly'
const teamSecretValue = 'team-secret-value-never-audited'
const dmarcPass = 'mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass'

type SandboxRun = {
	packageId: string
	request: RequestContext | null
	error: unknown
	emailTools: {
		getMessage: (messageId: string) => Promise<unknown>
		getAttachment: (attachmentId: string) => Promise<unknown>
	}
}

/** What the saved package does when it runs, given the run's caller context. */
type PackageCode = (
	callerContext: McpCallerContext,
	packageId: string,
) => Promise<unknown>

async function insertAccount(
	db: D1Database,
	input: { email: string; username: string },
) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
			 VALUES (?, ?, 'test-password-hash', ?, ?)`,
		)
		.bind(input.username, input.email, now, stableUserId)
		.run()
	await provisionPersonalOrg(db, {
		stableUserId,
		username: input.username,
		createdAt: now,
	})
	return personIdFromStored(stableUserId)
}

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	// Turning a cron enablement on reads its job row (jobs-worker schema).
	applyAllMigrations(
		sqlite,
		new URL('../../../jobs-worker/migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const auditDb = createAuditTestDb()
	const ownerId = await insertAccount(db, {
		email: 'owner@acme.example',
		username: 'owner',
	})
	const beaId = await insertAccount(db, {
		email: 'bea@acme.example',
		username: 'bea',
	})
	const cyId = await insertAccount(db, {
		email: 'cy@acme.example',
		username: 'cy',
	})
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: ownerId,
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
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
			 VALUES ('pkg-shared', ?, '@acme/pkg-shared', 'pkg-shared', '', 'source-pkg-shared')`,
		)
		.bind(orgId)
		.run()

	// A secret is granted by name, as accessGrant accepts it: the grant is
	// stored on the secret's credential id.
	const grant = async (
		subjectId: string,
		resourceType: 'package' | 'secret',
		resourceId: string,
	) =>
		await upsertGrant({
			db,
			orgId,
			subject: { type: 'user', id: subjectId },
			preset: 'use',
			permissions: null,
			createdByUserId: ownerId,
			audit: createTestOrgAuditWriter(),
			...(resourceType === 'secret'
				? {
						resourceType: 'credential',
						resourceId:
							(
								await findCredentialIdsByLegacyName(db, orgId, {
									type: 'secret',
									name: resourceId,
								})
							)[0] ?? '',
						family: 'secret',
					}
				: { resourceType, resourceId }),
		})
	// Bea and Cy may run pkg-shared.
	await grant(beaId, 'package', 'pkg-shared')
	await grant(cyId, 'package', 'pkg-shared')

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
	// Only Cy holds Use on the team secret.
	await grant(cyId, 'secret', 'teamToken')

	mocks.loadPackageManifestBySourceId.mockImplementation(
		async ({ sourceId }: { sourceId: string }) => ({
			manifest: {
				name: sourceId,
				kody: {
					id: sourceId,
					description: sourceId,
					subscriptions: {
						[emailTopic]: { handler: './src/handler.ts' },
						[eventTopic]: { handler: './src/handler.ts' },
					},
					jobs: {
						[jobName]: {
							entry: './src/job.ts',
							schedule: { type: 'interval', every: '1h' },
						},
					},
					webhooks: [
						{ name: 'incoming', export: './webhook', responseMode: 'ack' },
					],
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
				artifactName: 'handler',
				sourceId: savedPackage.sourceId,
				publishedCommit: 'commit-1',
				entryPoint: 'src/handler.ts',
				mainModule: 'dist/handler.js',
				modules: { 'dist/handler.js': 'export default () => null' },
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
	const resolveTeamToken = (
		request: RequestContext | null,
		packageId: string,
	) =>
		resolveCredential({
			env,
			orgId,
			actor: request,
			packageStamp: attestedPackageStamp(packageId),
			baseUrl: 'https://kody.example',
			credential: {
				use: 'secret',
				name: 'teamToken',
				storageContext: { sessionId: null, appId: packageId, packageId },
			},
		})
	let packageCode: PackageCode = (callerContext, packageId) =>
		resolveTeamToken(callerContext.request, packageId)
	mocks.runBundledModuleWithRegistry.mockImplementation(
		async (
			_env: Env,
			callerContext: McpCallerContext,
			_bundle: unknown,
			_params: unknown,
			options: {
				packageContext: { packageId: string }
				emailTools: SandboxRun['emailTools']
			},
		) => {
			const packageId = options.packageContext.packageId
			const run: SandboxRun = {
				packageId,
				request: callerContext.request,
				error: null,
				emailTools: options.emailTools,
			}
			runs.push(run)
			try {
				await packageCode(callerContext, packageId)
				return { result: { ok: true }, logs: [] }
			} catch (error) {
				run.error = error
				return { error, logs: [] }
			}
		},
	)

	const people = {
		owner: { userId: ownerId, username: 'owner' },
		bea: { userId: beaId, username: 'bea' },
		cy: { userId: cyId, username: 'cy' },
	} as const
	type Person = keyof typeof people

	const sessionFor = async (
		person: Person,
		scopes: ReadonlyArray<OrgPermission> | null = null,
	) => {
		const row = await db
			.prepare(
				`SELECT role FROM org_memberships
				 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
			)
			.bind(orgId, people[person].userId)
			.first<{ role: OrgRole }>()
		return deriveRequestContext({
			user: people[person],
			source: { kind: 'session' },
			orgBinding: {
				org: { id: orgId, slug: 'quillworks' },
				role: row?.role ?? null,
			},
			scopes,
		})
	}

	const enable = async (
		person: Person,
		kind: 'subscription' | 'cron' | 'webhook',
		name: string,
		scopes: ReadonlyArray<OrgPermission> | null = null,
	) => {
		// Email subscriptions are not turned on by enablementEnable. These tests
		// insert the member sender rule the enabler would approve.
		if (kind === 'subscription' && name === emailTopic) {
			return insertEnablement({
				db,
				enablement: {
					orgId,
					packageId: 'pkg-shared',
					triggerKind: 'subscription',
					triggerName: name,
					instanceId: 'pkg-shared',
					enablerUserId: people[person].userId,
					origin: 'enabled',
					senderKind: 'member',
					senderValue: people[person].userId,
				},
			})
		}
		return enableTriggerForCaller({
			env,
			baseUrl: 'https://kody.example',
			request: await sessionFor(person, scopes),
			packageIdOrKodyId: 'pkg-shared',
			kind,
			name,
		})
	}

	const enableWebhook = async (person: Person, endpointId: string) =>
		await insertEnablement({
			db,
			enablement: {
				orgId,
				packageId: 'pkg-shared',
				triggerKind: 'webhook',
				triggerName: 'incoming',
				instanceId: endpointId,
				enablerUserId: people[person].userId,
				origin: 'enabled',
			},
		})

	const sendEmail = (from: string, authResults = dmarcPass) =>
		dispatchInboundEmailSubscriptionEvents({
			env,
			userId: orgId,
			message: {
				id: `message-${crypto.randomUUID()}`,
				userId: orgId,
				inboxId: 'inbox-acme',
				fromAddress: from,
				envelopeFrom: from,
				toAddresses: ['team@acme.kody.example'],
				ccAddresses: [],
				replyToAddresses: [],
				subject: 'Hello',
				messageIdHeader: null,
				inReplyToHeader: null,
				references: [],
				authResults,
				processingStatus: 'stored',
				classification: 'accepted',
				classificationReason: null,
				receivedAt: now,
				createdAt: now,
			} as never,
		}) as Promise<Array<PackageInvocationResponse | null>>

	const deliverWebhook = (endpointId: string) =>
		dispatchWebhookInvocation({
			env,
			baseUrl: 'https://kody.example',
			endpoint: {
				id: endpointId,
				userId: orgId,
				packageId: 'pkg-shared',
				webhookName: 'incoming',
			},
			packageKodyId: 'pkg-shared',
			exportName: './webhook',
			params: { hello: 'world' },
			idempotencyKey: `delivery-${crypto.randomUUID()}`,
		})

	const raiseEvent = async (
		request: RequestSource,
		audience?: EnablementAudience,
	) => {
		const savedPackage = await getSavedPackageById(db, {
			userId: orgId,
			packageId: 'pkg-shared',
		})
		if (!savedPackage) throw new Error('Expected pkg-shared.')
		return await invokePackageSubscription({
			env,
			baseUrl: 'https://kody.example',
			savedPackage,
			topic: eventTopic,
			params: { thing: 1 },
			idempotencyKey: `event-${crypto.randomUUID()}`,
			request,
			...(audience ? { audience } : {}),
		})
	}

	const enablement = async (id: string) => {
		const record = await getEnablementById({ db, orgId, id })
		if (!record) throw new Error(`Missing enablement ${id}.`)
		return record
	}

	const removeFromOrg = async (person: Person) => {
		// A live grant alone keeps someone in as an outside collaborator.
		await db
			.prepare(
				`UPDATE org_memberships SET deleted_at = ? WHERE org_id = ? AND user_id = ?`,
			)
			.bind(now, orgId, people[person].userId)
			.run()
		await db
			.prepare(
				`UPDATE grants SET deleted_at = ?
				 WHERE org_id = ? AND subject_type = 'user' AND subject_id = ?`,
			)
			.bind(now, orgId, people[person].userId)
			.run()
	}

	const auditRows = async () => {
		await Promise.all(scheduledAudits.splice(0))
		const { results } = await auditDb
			.prepare(
				`SELECT actor_user_id, credential_kind, credential_id, result
				 FROM org_audit_events
				 WHERE action = 'credential.resolve' ORDER BY rowid`,
			)
			.all<{
				actor_user_id: string | null
				credential_kind: string | null
				credential_id: string | null
				result: string
			}>()
		return results
	}

	return {
		db,
		env,
		orgId,
		people,
		insertAccount: (input: { email: string; username: string }) =>
			insertAccount(db, input),
		runs,
		grant,
		enable,
		enableWebhook,
		sendEmail,
		deliverWebhook,
		raiseEvent,
		enablement,
		removeFromOrg,
		resolveTeamToken,
		auditRows,
		setPackageCode: (code: PackageCode) => {
			packageCode = code
		},
	}
}

test("a member's subscription cannot use an org credential they lack; it pauses, drops events, and resumes after a grant", async () => {
	const t = await setup()
	const beas = await t.enable('bea', 'subscription', emailTopic)

	await t.sendEmail('bea@acme.example')

	expect(t.runs).toHaveLength(1)
	expect(t.runs[0]?.request).toMatchObject({
		actor: { userId: t.people.bea.userId },
		attribution: { kind: 'user', userId: t.people.bea.userId },
		credential: { kind: 'inbound-email', id: beas.id },
		membership: { role: 'member' },
	})
	expect(t.runs[0]?.error).toMatchObject({
		name: 'AuthorizationError',
		permission: 'secret:use',
	})
	await expect(t.enablement(beas.id)).resolves.toMatchObject({
		state: 'paused',
		pause: {
			reason: 'credential_access',
			permission: 'secret:use',
			resourceType: 'secret',
			resourceId: 'teamToken',
		},
	})

	// Paused: the next event is dropped without running anything.
	t.runs.splice(0)
	const [dropped] = await t.sendEmail('bea@acme.example')
	expect(t.runs).toEqual([])
	expect(dropped).toMatchObject({
		status: 202,
		body: { skipped: { reason: 'no_enablement_on' } },
	})
	await expect(t.enablement(beas.id)).resolves.toMatchObject({
		state: 'paused',
	})

	// Granting Use resumes it on the next event, with no other step.
	await t.grant(t.people.bea.userId, 'secret', 'teamToken')
	await t.sendEmail('bea@acme.example')
	expect(t.runs).toHaveLength(1)
	expect(t.runs[0]?.error).toBeNull()
	expect(t.runs[0]?.request?.actor?.userId).toBe(t.people.bea.userId)
	await expect(t.enablement(beas.id)).resolves.toMatchObject({
		state: 'on',
		pause: null,
	})

	const rows = await t.auditRows()
	expect(rows.map((row) => [row.actor_user_id, row.result])).toEqual([
		[t.people.bea.userId, 'denied'],
		[t.people.bea.userId, 'success'],
	])
	expect(JSON.stringify(rows)).not.toContain(teamSecretValue)
})

test('a pause keeps the credential name people read and its id, and a pause on a credential that did not exist yet resumes once it exists and is granted', async () => {
	const t = await setup()
	const [teamTokenId] = await findCredentialIdsByLegacyName(t.db, t.orgId, {
		type: 'secret',
		name: 'teamToken',
	})
	const beas = await t.enable('bea', 'subscription', emailTopic)
	await t.sendEmail('bea@acme.example')
	await expect(t.enablement(beas.id)).resolves.toMatchObject({
		pause: {
			resourceType: 'secret',
			resourceId: 'teamToken',
			credentialId: teamTokenId,
		},
	})

	const cys = await t.enable('cy', 'subscription', emailTopic)
	t.setPackageCode(async (callerContext, packageId) => {
		await resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: callerContext.request,
			packageStamp: attestedPackageStamp(packageId),
			baseUrl: 'https://kody.example',
			credential: {
				use: 'secret',
				name: 'futureToken',
				storageContext: { sessionId: null, appId: packageId, packageId },
			},
		})
	})
	t.runs.splice(0)
	await t.sendEmail('cy@acme.example')
	expect(t.runs[0]?.error).toMatchObject({
		name: 'AuthorizationError',
		permission: 'secret:use',
	})
	await expect(t.enablement(cys.id)).resolves.toMatchObject({
		state: 'paused',
		pause: {
			resourceType: 'secret',
			resourceId: 'futureToken',
			credentialId: null,
		},
	})

	t.runs.splice(0)
	await saveSecret({
		env: t.env,
		userId: t.orgId,
		scope: 'user',
		name: 'futureToken',
		value: 'future-secret-value',
		audit: null,
	})
	await t.sendEmail('cy@acme.example')
	expect(t.runs).toEqual([])

	await t.grant(t.people.cy.userId, 'secret', 'futureToken')
	await t.sendEmail('cy@acme.example')
	expect(t.runs).toHaveLength(1)
	expect(t.runs[0]?.error).toBeNull()
	await expect(t.enablement(cys.id)).resolves.toMatchObject({
		state: 'on',
		pause: null,
	})
})

test('a run that references a vault with no binding pauses the enablement on Use and resumes on Use of the binding', async () => {
	const t = await setup()
	const cys = await t.enable('cy', 'subscription', emailTopic)
	t.setPackageCode(async (callerContext, packageId) => {
		await resolveCredential({
			env: t.env,
			orgId: t.orgId,
			actor: callerContext.request,
			packageStamp: attestedPackageStamp(packageId),
			baseUrl: 'https://kody.example',
			credential: {
				use: 'provider-secret',
				provider: '1password',
				ref: 'i/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/password',
				storageContext: { sessionId: null, appId: packageId, packageId },
			},
		})
	})
	t.runs.splice(0)
	await t.sendEmail('cy@acme.example')
	expect(t.runs[0]?.error).toMatchObject({
		name: 'AuthorizationError',
		permission: 'secret:use',
	})
	await expect(t.enablement(cys.id)).resolves.toMatchObject({
		state: 'paused',
		pause: {
			reason: 'credential_access',
			resourceType: 'secret-provider',
			resourceId: '1password',
			credentialId: null,
		},
	})

	// A stored secret with the provider's name is not the vault.
	await saveSecret({
		env: t.env,
		userId: t.orgId,
		scope: 'user',
		name: '1password',
		value: 'not-the-vault',
		audit: null,
	})
	await t.grant(t.people.cy.userId, 'secret', '1password')
	t.runs.splice(0)
	await t.sendEmail('cy@acme.example')
	expect(t.runs).toEqual([])

	await t.db
		.prepare(
			`INSERT INTO secret_provider_bindings (
				user_id, provider_id, package_id, door_secret_name, config_json
			) VALUES (?, '1password', 'pkg-shared', 'opToken', '{}')`,
		)
		.bind(t.orgId)
		.run()
	await t.sendEmail('cy@acme.example')
	expect(t.runs).toEqual([])

	const binding = await t.db
		.prepare(`SELECT id FROM secret_provider_bindings WHERE user_id = ?`)
		.bind(t.orgId)
		.first<{ id: string }>()
	await upsertGrant({
		db: t.db,
		orgId: t.orgId,
		resourceType: 'credential',
		resourceId: binding?.id ?? '',
		family: 'secret',
		subject: { type: 'user', id: t.people.cy.userId },
		preset: 'use',
		permissions: null,
		createdByUserId: t.people.owner.userId,
		audit: createTestOrgAuditWriter(),
	})
	t.setPackageCode(async () => {})
	await t.sendEmail('cy@acme.example')
	expect(t.runs).toHaveLength(1)
	await expect(t.enablement(cys.id)).resolves.toMatchObject({
		state: 'on',
		pause: null,
	})
})

test('a grant on a credential deleted since the pause does not resume the enablement', async () => {
	const t = await setup()
	const beas = await t.enable('bea', 'subscription', emailTopic)
	await t.sendEmail('bea@acme.example')
	await expect(t.enablement(beas.id)).resolves.toMatchObject({
		state: 'paused',
	})

	await t.grant(t.people.bea.userId, 'secret', 'teamToken')
	await deleteSecret({
		env: t.env,
		userId: t.orgId,
		scope: 'user',
		name: 'teamToken',
		audit: null,
	})
	t.runs.splice(0)
	await t.sendEmail('bea@acme.example')
	expect(t.runs).toEqual([])
	await expect(t.enablement(beas.id)).resolves.toMatchObject({
		state: 'paused',
		pause: { reason: 'credential_access', resourceId: 'teamToken' },
	})
})

test('a pause on a credential whose row is gone never resumes through a same-named secret', async () => {
	const t = await setup()
	const beas = await t.enable('bea', 'subscription', emailTopic)
	await t.sendEmail('bea@acme.example')
	// A vault binding is hard-deleted, leaving the pause's id naming no row.
	await t.db
		.prepare(
			`UPDATE enablements SET paused_credential_id = ? WHERE id = ? AND org_id = ?`,
		)
		.bind('removed-vault-binding', beas.id, t.orgId)
		.run()

	await t.grant(t.people.bea.userId, 'secret', 'teamToken')
	t.runs.splice(0)
	await t.sendEmail('bea@acme.example')
	expect(t.runs).toEqual([])
	await expect(t.enablement(beas.id)).resolves.toMatchObject({
		state: 'paused',
		pause: { credentialId: 'removed-vault-binding' },
	})
})

test('a pause on an integration name shared by two credentials resumes once either is granted', async () => {
	const t = await setup()
	const beas = await t.enable('bea', 'subscription', emailTopic)
	await t.sendEmail('bea@acme.example')
	await t.grant(t.people.bea.userId, 'secret', 'teamToken')
	await t.db
		.prepare(
			`INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, flow)
			 VALUES (?, 'google', 'google', 'client-id', 'https://oauth2.example.com/token', 'pkce')`,
		)
		.bind(t.orgId)
		.run()
	await t.db
		.prepare(
			`INSERT INTO user_integrations (user_id, name, app_slug) VALUES (?, 'shared', 'google')`,
		)
		.bind(t.orgId)
		.run()
	const serverId = crypto.randomUUID()
	await t.db
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url) VALUES (?, ?, 'shared', 'https://mcp.example.com')`,
		)
		.bind(serverId, t.orgId)
		.run()
	// Paused on the name before either credential existed.
	await t.db
		.prepare(
			`UPDATE enablements
			 SET paused_permission = 'integration:use', paused_resource_type = 'integration',
			     paused_resource_id = 'shared', paused_credential_id = NULL
			 WHERE id = ? AND org_id = ?`,
		)
		.bind(beas.id, t.orgId)
		.run()

	t.runs.splice(0)
	await t.sendEmail('bea@acme.example')
	expect(t.runs).toEqual([])

	await upsertGrant({
		db: t.db,
		orgId: t.orgId,
		resourceType: 'credential',
		resourceId: serverId,
		family: 'integration',
		subject: { type: 'user', id: t.people.bea.userId },
		preset: 'use',
		permissions: null,
		createdByUserId: t.people.owner.userId,
		audit: createTestOrgAuditWriter(),
	})
	await t.sendEmail('bea@acme.example')
	expect(t.runs).toHaveLength(1)
	expect(t.runs[0]?.error).toBeNull()
	await expect(t.enablement(beas.id)).resolves.toMatchObject({
		state: 'on',
		pause: null,
	})
})

test("a member's paused email subscription waits on that member's own list, not the org's (#3317)", async () => {
	const t = await setup()
	const beas = await t.enable('bea', 'subscription', emailTopic)
	await t.enable('cy', 'subscription', emailTopic)
	await t.sendEmail('bea@acme.example')
	await expect(t.enablement(beas.id)).resolves.toMatchObject({
		state: 'paused',
	})

	const waitingIds = async (
		person: keyof typeof t.people,
		orgId: OwnerId = t.orgId,
	) => {
		const personId = t.people[person].userId
		const row = await t.db
			.prepare(`SELECT id FROM users WHERE stable_user_id = ?`)
			.bind(personId)
			.first<{ id: number }>()
		const signals = await collectWaitingSignals({
			env: t.env,
			user: {
				userId: row!.id,
				stableUserId: orgId,
				actorStableUserId: personalOrgId(personId),
				email: `${person}@acme.example`,
				username: t.people[person].username,
				emailVerified: true,
			},
		})
		return buildWaitingItems(signals, 'quillworks')
			.filter((item) => item.kind === 'enablement-paused')
			.map((item) => ({ id: item.id, title: item.title, why: item.why }))
	}

	expect(await waitingIds('bea')).toEqual([
		{
			id: `enablement-paused:${beas.id}`,
			title: `Your @acme/pkg-shared "${emailTopic}" subscription is paused`,
			why: expect.stringContaining('Use on the secret "teamToken"'),
		},
	])
	expect(await waitingIds('cy')).toEqual([])
	expect(await waitingIds('owner')).toEqual([])
	expect(await waitingIds('bea', personalOrgId(t.people.bea.userId))).toEqual(
		[],
	)

	// Agents read the same queue for the org their connection is bound to.
	const mcpWaitingIds = async (orgId: OwnerId | null) =>
		(
			await deriveWaitingItemsForStableUser({
				env: t.env,
				personId: t.people.bea.userId,
				orgId,
				email: 'bea@acme.example',
			})
		)
			.filter((item) => item.kind === 'enablement-paused')
			.map((item) => item.id)
	expect(await mcpWaitingIds(t.orgId)).toEqual([`enablement-paused:${beas.id}`])
	expect(await mcpWaitingIds(null)).toEqual([])

	await t.grant(t.people.bea.userId, 'secret', 'teamToken')
	await t.sendEmail('bea@acme.example')
	expect(await waitingIds('bea')).toEqual([])
	expect(await mcpWaitingIds(t.orgId)).toEqual([])
})

test("a member's webhook runs as its enabler, never as Owner, and a paused one answers 409", async () => {
	const t = await setup()
	const beas = await t.enableWebhook('bea', 'endpoint-bea')

	const first = await t.deliverWebhook('endpoint-bea')

	expect(t.runs).toHaveLength(1)
	expect(t.runs[0]?.request).toMatchObject({
		actor: { userId: t.people.bea.userId },
		credential: { kind: 'webhook', id: beas.id },
		membership: { role: 'member' },
	})
	expect(t.runs[0]?.error).toMatchObject({ name: 'AuthorizationError' })
	expect(first.status).toBeGreaterThanOrEqual(400)
	await expect(t.enablement(beas.id)).resolves.toMatchObject({
		state: 'paused',
		pause: { reason: 'credential_access', resourceId: 'teamToken' },
	})

	t.runs.splice(0)
	const second = await t.deliverWebhook('endpoint-bea')
	expect(t.runs).toEqual([])
	expect(second).toMatchObject({
		status: 409,
		body: { error: { code: 'enablement_not_on' } },
	})

	// A webhook nobody turned on runs nothing, not even as Owner.
	const unenabled = await t.deliverWebhook('endpoint-nobody')
	expect(t.runs).toEqual([])
	expect(unenabled.status).toBe(409)
})

test("a member's cron job runs as its enabler and cannot use an org credential they lack", async () => {
	const t = await setup()
	consoleInfo.mockImplementation(() => {})
	const beas = await t.enable('bea', 'cron', jobName)
	const cys = await t.enable('cy', 'cron', jobName)
	const jobId = buildPackageJobId('pkg-shared', jobName)
	expect(beas.instanceId).toBe(jobId)

	const runTick = async () => {
		const plan = await planEnablementRuns({
			env: t.env,
			orgId: t.orgId,
			packageId: 'pkg-shared',
			trigger: { kind: 'cron', instanceId: jobId },
		})
		const outcomes = []
		for (const run of plan.runs) {
			const request = deriveRequestContext({
				user: run.enabler,
				source: { kind: 'schedule', jobId, enablement: run },
				orgBinding: {
					org: { id: t.orgId, slug: 'quillworks' },
					role: run.role,
				},
			})
			outcomes.push(
				await t.resolveTeamToken(request, 'pkg-shared').then(
					(secret) => ({ enabler: run.enabler.userId, secret }),
					(error: unknown) => ({ enabler: run.enabler.userId, error }),
				),
			)
		}
		return outcomes
	}

	const outcomes = await runTick()
	const outcomeOf = (userId: string) =>
		outcomes.find((outcome) => outcome.enabler === userId)
	expect(outcomes).toHaveLength(2)
	expect(outcomeOf(t.people.bea.userId)).toMatchObject({
		enabler: t.people.bea.userId,
		error: { name: 'AuthorizationError', permission: 'secret:use' },
	})
	expect(outcomeOf(t.people.cy.userId)).toMatchObject({
		enabler: t.people.cy.userId,
		secret: { found: true, value: teamSecretValue },
	})
	await expect(t.enablement(beas.id)).resolves.toMatchObject({
		state: 'paused',
	})
	await expect(t.enablement(cys.id)).resolves.toMatchObject({ state: 'on' })

	// Next tick: only Cy runs; Bea's stays paused while she still lacks Use.
	const next = await runTick()
	expect(next.map((outcome) => outcome.enabler)).toEqual([t.people.cy.userId])
})

test('a cron job turned on through a scoped credential never exceeds those scopes', async () => {
	const t = await setup()
	consoleInfo.mockImplementation(() => {})
	const cys = await t.enable('cy', 'cron', jobName, ['package:execute'])
	expect(cys.enablerScopes).toEqual(['package:execute'])
	const jobId = buildPackageJobId('pkg-shared', jobName)
	const plan = await planEnablementRuns({
		env: t.env,
		orgId: t.orgId,
		packageId: 'pkg-shared',
		trigger: { kind: 'cron', instanceId: jobId },
	})
	expect(plan.runs.map((run) => run.scopes)).toEqual([['package:execute']])
	const [run] = plan.runs
	const request = deriveRequestContext({
		user: run!.enabler,
		source: { kind: 'schedule', jobId, enablement: run },
		orgBinding: {
			org: { id: t.orgId, slug: 'quillworks' },
			role: run!.role,
		},
	})
	expect(request.credential.scopes).toEqual(['package:execute'])
	// Cy holds Use on the team secret; the credential that enabled it does not.
	await expect(t.resolveTeamToken(request, 'pkg-shared')).rejects.toMatchObject(
		{ name: 'AuthorizationError', permission: 'secret:use' },
	)
})

test('a credential without package:execute cannot turn a trigger on, and a stored one pauses before it runs', async () => {
	const t = await setup()
	consoleInfo.mockImplementation(() => {})
	await expect(
		t.enable('cy', 'cron', jobName, ['secret:use']),
	).rejects.toMatchObject({
		name: 'AuthorizationError',
		permission: 'package:execute',
	})
	const jobId = buildPackageJobId('pkg-shared', jobName)
	const stored = await insertEnablement({
		db: t.db,
		enablement: {
			orgId: t.orgId,
			packageId: 'pkg-shared',
			triggerKind: 'cron',
			triggerName: jobName,
			instanceId: jobId,
			enablerUserId: t.people.cy.userId,
			enablerScopes: ['secret:use'],
			origin: 'enabled',
		},
	})
	const plan = await planEnablementRuns({
		env: t.env,
		orgId: t.orgId,
		packageId: 'pkg-shared',
		trigger: { kind: 'cron', instanceId: jobId },
	})
	expect(plan.runs).toEqual([])
	await expect(t.enablement(stored.id)).resolves.toMatchObject({
		state: 'paused',
		pause: { reason: 'package_access', permission: 'package:execute' },
	})
})

test("a just-removed member's enablements pause on the next run and resume when they are back", async () => {
	const t = await setup()
	const cyWebhook = await t.enableWebhook('cy', 'endpoint-cy')
	const cyEvents = await t.enable('cy', 'subscription', eventTopic)

	await t.deliverWebhook('endpoint-cy')
	expect(t.runs).toHaveLength(1)
	expect(t.runs[0]?.error).toBeNull()

	await t.removeFromOrg('cy')
	t.runs.splice(0)

	const webhook = await t.deliverWebhook('endpoint-cy')
	expect(webhook.status).toBe(409)
	await expect(t.enablement(cyWebhook.id)).resolves.toMatchObject({
		state: 'paused',
		pause: { reason: 'org_access' },
	})
	const event = await t.raiseEvent({
		kind: 'platform-event',
		sourceId: 'integration:acme',
	})
	expect(event.status).toBe(202)
	await expect(t.enablement(cyEvents.id)).resolves.toMatchObject({
		state: 'paused',
		pause: { reason: 'org_access' },
	})
	expect(t.runs).toEqual([])

	// Back in the org with Use again: both resume on their next event.
	await t.db
		.prepare(
			`UPDATE org_memberships SET deleted_at = NULL WHERE org_id = ? AND user_id = ?`,
		)
		.bind(t.orgId, t.people.cy.userId)
		.run()
	await t.db
		.prepare(
			`UPDATE grants SET deleted_at = NULL WHERE org_id = ? AND subject_id = ?`,
		)
		.bind(t.orgId, t.people.cy.userId)
		.run()
	await t.deliverWebhook('endpoint-cy')
	await expect(t.enablement(cyWebhook.id)).resolves.toMatchObject({
		state: 'on',
	})
	expect(t.runs.map((run) => run.error)).toEqual([null])
})

test("webhook- and run-raised events reach only that run's enabler's subscriptions", async () => {
	const t = await setup()
	await t.enable('owner', 'subscription', eventTopic)
	await t.enable('bea', 'subscription', eventTopic)
	const cys = await t.enable('cy', 'subscription', eventTopic)
	const cyWebhook = await t.enableWebhook('cy', 'endpoint-cy')

	// The event a webhook run raises inherits that run's request.
	await t.deliverWebhook('endpoint-cy')
	const webhookRun = t.runs[0]?.request
	expect(webhookRun?.credential.id).toBe(cyWebhook.id)
	t.runs.splice(0)

	await t.raiseEvent(inheritRequest(webhookRun!))
	expect(t.runs.map((run) => run.request?.actor?.userId)).toEqual([
		t.people.cy.userId,
	])
	expect(t.runs[0]?.request?.credential.id).toBe(cys.id)
	expect(t.runs[0]?.error).toBeNull()

	// A run with no person reaches nobody.
	t.runs.splice(0)
	const orphan = await t.raiseEvent({
		kind: 'inherited',
		lineage: {
			actor: null,
			attribution: {
				kind: 'automation',
				source: 'schedule',
				sourceId: 'job-x',
			},
			credential: {
				kind: 'schedule',
				id: 'job-x',
				orgId: t.orgId,
				scopes: null,
				profileName: null,
			},
			membership: null,
		},
	})
	expect(t.runs).toEqual([])
	expect(orphan.status).toBe(202)

	// An org-wide platform event reaches every enabler who can see it.
	await t.raiseEvent({ kind: 'platform-event', sourceId: 'integration:acme' })
	expect(
		t.runs.map((run) => String(run.request?.actor?.userId)).sort(),
	).toEqual(
		[t.people.owner.userId, t.people.bea.userId, t.people.cy.userId]
			.map(String)
			.sort(),
	)
})

test("member email runs only that member's rule; unmatched mail runs nothing", async () => {
	const t = await setup()
	const owners = await t.enable('owner', 'subscription', emailTopic)
	const cys = await t.enable('cy', 'subscription', emailTopic)

	await t.sendEmail('cy@acme.example')
	expect(t.runs.map((run) => run.request?.credential.id)).toEqual([cys.id])
	expect(t.runs[0]?.request?.actor?.userId).toBe(t.people.cy.userId)
	expect(t.runs[0]?.error).toBeNull()

	t.runs.splice(0)
	await t.sendEmail('receipts@shop.example', 'mx; spf=pass; dkim=none')
	expect(t.runs).toEqual([])

	// Bea has no enablement, so her mail runs nothing, not Cy's or Owner's.
	t.runs.splice(0)
	await t.sendEmail('bea@acme.example')
	expect(t.runs).toEqual([])

	await t.db
		.prepare(
			`UPDATE enablements
			 SET sender_kind = 'any_authenticated', sender_value = NULL
			 WHERE id = ?`,
		)
		.bind(owners.id)
		.run()
	t.runs.splice(0)
	await t.sendEmail('receipts@shop.example', 'mx; spf=pass; dkim=none')
	expect(t.runs.map((run) => run.request?.credential.id)).toEqual([owners.id])
	expect(t.runs[0]?.request).toMatchObject({
		actor: { userId: t.people.owner.userId },
		membership: { role: 'owner' },
	})
})

test('team member mail runs packages they can execute, including any_authenticated, and skips the rest', async () => {
	const t = await setup()
	const insertPackage = (id: string) =>
		t.db
			.prepare(
				`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
				 VALUES (?, ?, ?, ?, '', ?)`,
			)
			.bind(id, t.orgId, `@acme/${id}`, id, `source-${id}`)
			.run()
	await insertPackage('pkg-open')
	await insertPackage('pkg-locked')
	await t.grant(t.people.bea.userId, 'package', 'pkg-open')
	await t.enable('bea', 'subscription', emailTopic)
	await insertEnablement({
		db: t.db,
		enablement: {
			orgId: t.orgId,
			packageId: 'pkg-open',
			triggerKind: 'subscription',
			triggerName: emailTopic,
			instanceId: 'pkg-open',
			enablerUserId: t.people.bea.userId,
			origin: 'enabled',
			senderKind: 'any_authenticated',
			senderValue: null,
		},
	})
	await insertEnablement({
		db: t.db,
		enablement: {
			orgId: t.orgId,
			packageId: 'pkg-locked',
			triggerKind: 'subscription',
			triggerName: emailTopic,
			instanceId: 'pkg-locked',
			enablerUserId: t.people.bea.userId,
			origin: 'enabled',
			senderKind: 'member',
			senderValue: t.people.bea.userId,
		},
	})
	t.setPackageCode(async () => null)

	await t.sendEmail('bea@acme.example')

	expect(t.runs.map((run) => run.packageId).sort()).toEqual([
		'pkg-open',
		'pkg-shared',
	])
	for (const run of t.runs) {
		expect(run.request?.org.id).toBe(t.orgId)
		expect(run.request?.actor?.userId).toBe(t.people.bea.userId)
		expect(run.error).toBeNull()
	}
})

test('turning a trigger on again keeps one enablement per person', async () => {
	const t = await setup()
	const beasCron = await t.enable('bea', 'cron', jobName)
	expect((await t.enable('bea', 'cron', jobName)).id).toBe(beasCron.id)
	const beasEvents = await t.enable('bea', 'subscription', eventTopic)
	expect((await t.enable('bea', 'subscription', eventTopic)).id).toBe(
		beasEvents.id,
	)
	expect((await t.enable('bea', 'subscription', emailTopic)).id).not.toBe(
		beasEvents.id,
	)
	expect((await t.enable('cy', 'cron', jobName)).id).not.toBe(beasCron.id)

	consoleInfo.mockImplementation(() => {})
	const plan = await planEnablementRuns({
		env: t.env,
		orgId: t.orgId,
		packageId: 'pkg-shared',
		trigger: {
			kind: 'cron',
			instanceId: buildPackageJobId('pkg-shared', jobName),
		},
	})
	expect(plan.runs.map((run) => String(run.enabler.userId)).sort()).toEqual(
		[t.people.bea.userId, t.people.cy.userId].map(String).sort(),
	)
})

test('webhook approval initializes its signing secret', async () => {
	const t = await setup()
	await t.db
		.prepare(
			`INSERT INTO webhook_endpoints (
				id, user_id, package_id, webhook_name, url_secret_hash,
				url_secret_encrypted, created_at, rotated_at
			) VALUES ('endpoint-off', ?, 'pkg-shared', 'incoming', 'hash', 'ciphertext', ?, ?)`,
		)
		.bind(t.orgId, now, now)
		.run()
	const readSecret = async () =>
		(
			await t.db
				.prepare(
					`SELECT hmac_secret_encrypted FROM webhook_endpoints WHERE id = 'endpoint-off'`,
				)
				.first<{ hmac_secret_encrypted: string | null }>()
		)?.hmac_secret_encrypted

	expect(await readSecret()).toBeNull()
	// Approving (which plans and writes the enablement outside this call)
	// is what first turns a webhook on; enablementEnable only returns it.
	const approved = await t.enableWebhook('bea', 'endpoint-off')
	const enabled = await t.enable('bea', 'webhook', 'incoming')
	expect(enabled.id).toBe(approved.id)
	expect(enabled).toMatchObject({
		instanceId: 'endpoint-off',
		enablerUserId: t.people.bea.userId,
	})
	const secret = await readSecret()
	expect(secret).toBeTruthy()

	// Enabling again keeps the same enablement and the same secret.
	expect((await t.enable('bea', 'webhook', 'incoming')).id).toBe(enabled.id)
	expect(await readSecret()).toBe(secret)
})

test('enablementEnable refuses a webhook with no enablement and points at Approve', async () => {
	const t = await setup()
	await t.db
		.prepare(
			`INSERT INTO webhook_endpoints (
				id, user_id, package_id, webhook_name, url_secret_hash,
				url_secret_encrypted, created_at, rotated_at
			) VALUES ('endpoint-new', ?, 'pkg-shared', 'incoming', 'hash', 'ciphertext', ?, ?)`,
		)
		.bind(t.orgId, now, now)
		.run()
	const webhookEnablements = async () =>
		(
			await t.db
				.prepare(
					`SELECT COUNT(*) AS n FROM enablements WHERE trigger_kind = 'webhook'`,
				)
				.first<{ n: number }>()
		)?.n

	const refused = await t.enable('bea', 'webhook', 'incoming').then(
		() => null,
		(error: unknown) => error,
	)
	expect(refused).toBeInstanceOf(TriggerEnablementError)
	expect(refused).toMatchObject({ code: 'webhook_approval_required' })
	expect((refused as Error).message).toContain(
		'https://kody.example/@quillworks/pkg-shared/approve-credentials?enable=webhook%3Aincoming',
	)
	expect(await webhookEnablements()).toBe(0)

	// Someone else's live enablement still blocks, and an existing one is
	// returned as is.
	const owners = await t.enableWebhook('owner', 'endpoint-new')
	await expect(t.enable('bea', 'webhook', 'incoming')).rejects.toMatchObject({
		code: 'webhook_other_enabler',
	})
	expect((await t.enable('owner', 'webhook', 'incoming')).id).toBe(owners.id)
	expect(await webhookEnablements()).toBe(1)
})

test('enablementEnable refuses inbound email and points at Approve', async () => {
	const t = await setup()
	const count = async () =>
		(
			await t.db
				.prepare(`SELECT COUNT(*) AS n FROM enablements`)
				.first<{ n: number }>()
		)?.n
	const before = await count()
	const request = deriveRequestContext({
		user: t.people.bea,
		source: { kind: 'session' },
		orgBinding: {
			org: { id: t.orgId, slug: 'quillworks' },
			role: 'member',
		},
	})
	const refuse = (name: string) =>
		enableTriggerForCaller({
			env: t.env,
			baseUrl: 'https://kody.example',
			request,
			packageIdOrKodyId: 'pkg-shared',
			kind: 'subscription',
			name,
		}).then(
			() => null,
			(error: unknown) => error,
		)
	const direct = await refuse(emailTopic)
	expect(direct).toBeInstanceOf(TriggerEnablementError)
	expect(direct).toMatchObject({ code: 'email_approval_required' })
	expect((direct as Error).message).toContain(
		'https://kody.example/@quillworks/pkg-shared/approve-credentials?enable=subscription%3Aemail.message.received',
	)
	expect((direct as Error).message).toContain('sender_kind')
	expect((direct as Error).message).toContain('enablementEnable cannot')
	expect(await refuse('email.message.quarantined')).toMatchObject({
		code: 'email_approval_required',
	})
	expect(await count()).toBe(before)
})

test('enablementEnable still turns a cron job and a subscription on', async () => {
	const t = await setup()
	expect(await t.enable('bea', 'cron', jobName)).toMatchObject({
		triggerKind: 'cron',
		state: 'on',
		enablerUserId: t.people.bea.userId,
	})
	expect(await t.enable('bea', 'subscription', eventTopic)).toMatchObject({
		triggerKind: 'subscription',
		state: 'on',
	})
})

test('a webhook enablement that loses the one-live race is webhook_other_enabler, whether it writes nothing or hits the index', async () => {
	const t = await setup()
	const winner = await t.enableWebhook('owner', 'endpoint-race')
	const planFor = (build: typeof buildInsertWebhookEnablementStatement) => {
		const { id, statement } = build({
			db: t.db,
			enablement: {
				orgId: t.orgId,
				packageId: 'pkg-shared',
				triggerKind: 'webhook',
				triggerName: 'incoming',
				instanceId: 'endpoint-race',
				enablerUserId: t.people.bea.userId,
				origin: 'enabled',
			},
			now,
		})
		return {
			enablement: null,
			kind: 'webhook' as const,
			triggerName: 'incoming',
			orgId: t.orgId,
			instanceId: 'endpoint-race',
			enablementId: id,
			statement,
			prepareStatements: async () => [],
		}
	}
	await expect(
		runNewEnablementPlans({
			db: t.db,
			plans: [planFor(buildInsertWebhookEnablementStatement)],
		}),
	).rejects.toMatchObject({ code: 'webhook_other_enabler' })
	await expect(
		runNewEnablementPlans({
			db: t.db,
			plans: [planFor(buildInsertEnablementStatement)],
		}),
	).rejects.toMatchObject({ code: 'webhook_other_enabler' })
	const live = await t.db
		.prepare(
			`SELECT id FROM enablements WHERE trigger_kind = 'webhook' AND state <> 'off'`,
		)
		.all<{ id: string }>()
	expect(live.results.map((row) => row.id)).toEqual([winner.id])
})

test('an org-wide event reaches an enabler holding any permission on its resource', async () => {
	const t = await setup()
	await t.enable('owner', 'subscription', eventTopic)
	await t.enable('bea', 'subscription', eventTopic)
	await t.enable('cy', 'subscription', eventTopic)
	await upsertGrant({
		db: t.db,
		orgId: t.orgId,
		resourceType: 'package',
		resourceId: 'pkg-other',
		subject: { type: 'user', id: t.people.bea.userId },
		preset: null,
		permissions: ['package:write'],
		createdByUserId: t.people.owner.userId,
		audit: createTestOrgAuditWriter(),
	})

	await t.raiseEvent(
		{ kind: 'platform-event', sourceId: 'run-error:pkg-other' },
		{ resource: { type: 'package', id: 'pkg-other' } },
	)

	expect(
		t.runs.map((run) => String(run.request?.actor?.userId)).sort(),
	).toEqual([t.people.owner.userId, t.people.bea.userId].map(String).sort())
})

test('mail from a non-member does not fall back to the next live Owner', async () => {
	const t = await setup()
	await t.enable('owner', 'subscription', emailTopic)
	const deeId = await t.insertAccount({
		email: 'dee@acme.example',
		username: 'dee',
	})
	await t.db
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
		.bind(t.orgId, deeId, '2026-10-12T00:00:00.000Z')
		.run()
	await insertEnablement({
		db: t.db,
		enablement: {
			orgId: t.orgId,
			packageId: 'pkg-shared',
			triggerKind: 'subscription',
			triggerName: emailTopic,
			instanceId: 'pkg-shared',
			enablerUserId: deeId,
			origin: 'enabled',
			senderKind: 'member',
			senderValue: deeId,
		},
	})
	await t.db
		.prepare(`UPDATE users SET suspended_at = ? WHERE stable_user_id = ?`)
		.bind(now, t.people.owner.userId)
		.run()

	await t.sendEmail('receipts@shop.example', 'mx; spf=pass; dkim=none')
	expect(t.runs).toEqual([])
})

test("a run as a member reads org mail only with that member's email:read", async () => {
	const t = await setup()
	await t.enable('bea', 'subscription', emailTopic)
	const owners = await t.enable('owner', 'subscription', emailTopic)

	await t.sendEmail('bea@acme.example')
	const beasRun = t.runs[0]
	expect(beasRun?.request?.actor?.userId).toBe(t.people.bea.userId)
	await expect(
		beasRun!.emailTools.getMessage('message-1'),
	).rejects.toMatchObject({
		name: 'AuthorizationError',
		permission: 'email:read',
	})
	await expect(
		beasRun!.emailTools.getAttachment('attachment-1'),
	).rejects.toMatchObject({
		name: 'AuthorizationError',
		permission: 'email:read',
	})

	await t.db
		.prepare(
			`UPDATE enablements
			 SET sender_kind = 'any_authenticated', sender_value = NULL
			 WHERE id = ?`,
		)
		.bind(owners.id)
		.run()
	t.runs.splice(0)
	await t.sendEmail('receipts@shop.example', 'mx; spf=pass; dkim=none')
	const ownersRun = t.runs[0]
	expect(ownersRun?.request?.actor?.userId).toBe(t.people.owner.userId)
	const ownerError = await ownersRun!.emailTools
		.getMessage('message-missing')
		.catch((error: unknown) => error)
	expect(ownerError).not.toMatchObject({ name: 'AuthorizationError' })
})

test('a member cannot make themselves Owner through a job or webhook in a package they saved', async () => {
	const t = await setup()
	consoleInfo.mockImplementation(() => {})
	const promoteBea = (callerContext: McpCallerContext) =>
		orgMemberUpdateCapability.handler(
			{ username: 'bea', role: 'owner' },
			{ env: t.env, callerContext },
		)
	t.setPackageCode(promoteBea)
	const beasRole = async () =>
		(
			await t.db
				.prepare(
					`SELECT role FROM org_memberships
					 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
				)
				.bind(t.orgId, t.people.bea.userId)
				.first<{ role: string }>()
		)?.role
	const jobId = buildPackageJobId('pkg-shared', jobName)
	const orgBinding = { org: { id: t.orgId, slug: 'quillworks' } }
	const tick = async () => {
		const plan = await planEnablementRuns({
			env: t.env,
			orgId: t.orgId,
			packageId: 'pkg-shared',
			trigger: { kind: 'cron', instanceId: jobId },
		})
		return await Promise.all(
			plan.runs.map((run) => {
				const callerContext = createMcpCallerContext({
					baseUrl: 'https://kody.example',
					user: {
						...run.enabler,
						email: `${run.enabler.username}@acme.example`,
						displayName: run.enabler.username ?? '',
					},
					source: { kind: 'schedule', jobId, enablement: run },
					orgBinding: { ...orgBinding, role: run.role },
				})
				return promoteBea(callerContext).then(
					() => ({ request: callerContext.request, error: null }),
					(error: unknown) => ({ request: callerContext.request, error }),
				)
			}),
		)
	}

	// Saved but turned on by nobody: neither trigger runs.
	expect(await tick()).toEqual([])
	expect((await t.deliverWebhook('endpoint-bea')).status).toBe(409)
	expect(t.runs).toEqual([])

	// Turned on by Bea: both run as Bea, and a role change needs a live person.
	await t.enable('bea', 'cron', jobName)
	await t.enableWebhook('bea', 'endpoint-bea')
	const [cronRun, ...otherCronRuns] = await tick()
	expect(otherCronRuns).toEqual([])
	expect(cronRun).toMatchObject({
		request: { actor: { userId: t.people.bea.userId } },
		error: {
			name: 'LivePersonRequiredError',
			capabilityName: 'orgMemberUpdate',
		},
	})
	await t.deliverWebhook('endpoint-bea')
	expect(t.runs).toHaveLength(1)
	expect(t.runs[0]).toMatchObject({
		request: { actor: { userId: t.people.bea.userId } },
		error: {
			name: 'LivePersonRequiredError',
			capabilityName: 'orgMemberUpdate',
		},
	})
	expect(await beasRole()).toBe('member')

	// A scheduled request that names no enabler holds no permissions at all.
	const nobody = createMcpCallerContext({
		baseUrl: 'https://kody.example',
		user: {
			userId: personIdFromStored(t.orgId as string),
			username: 'quillworks',
			email: 'team@acme.example',
			displayName: 'Acme',
		},
		source: { kind: 'schedule', jobId },
		orgBinding: { ...orgBinding, role: 'owner' },
	})
	expect(nobody.request?.actor).toBeNull()
	await expect(promoteBea(nobody)).rejects.toMatchObject({
		name: 'LivePersonRequiredError',
	})
	expect(await beasRole()).toBe('member')

	// Turned on by an Owner, it still cannot change roles: that needs a live
	// person, whatever the enabler's role.
	await t.enable('owner', 'cron', jobName)
	const outcomes = await tick()
	expect(
		outcomes.find(
			(outcome) => outcome.request?.actor?.userId === t.people.owner.userId,
		),
	).toMatchObject({
		error: {
			name: 'LivePersonRequiredError',
			capabilityName: 'orgMemberUpdate',
		},
	})
	expect(await beasRole()).toBe('member')
})

test("an Owner's job, webhook, and email handler cannot change roles, and reach site-admin tools only as a site admin (#2393)", async () => {
	const t = await setup()
	consoleInfo.mockImplementation(() => {})
	await t.db
		.prepare(
			`INSERT INTO user_roles (user_id, role_id)
			 SELECT u.id, r.id FROM users u, roles r
			 WHERE u.stable_user_id = ? AND r.name = 'admin'`,
		)
		.bind(t.people.owner.userId)
		.run()
	const roleChange = (callerContext: McpCallerContext) =>
		orgMemberUpdateCapability.handler(
			{ username: 'bea', role: 'owner' },
			{ env: t.env, callerContext },
		)
	const siteAdminCalls = {
		adminCreditGrant: (callerContext: McpCallerContext) =>
			adminCreditGrantCapability.handler(
				{ username: 'bea', amountCents: 100_000 },
				{ env: t.env, callerContext },
			),
		adminUserUpdate: (callerContext: McpCallerContext) =>
			adminUserUpdateCapability.handler(
				{ username: 'owner', plan: 'pro' },
				{ env: t.env, callerContext },
			),
		adminFeatureFlagSet: (callerContext: McpCallerContext) =>
			adminFeatureFlagSetCapability.handler(
				{ key: 'demo-indicator', enabled: true },
				{ env: t.env, callerContext },
			),
	}
	type Attempt = {
		credential: string | undefined
		roleChange: string
		siteAdmin: Record<string, string>
	}
	const attempts: Array<Attempt> = []
	const outcomeOf = async (call: () => Promise<unknown>) => {
		try {
			await call()
			return 'ok'
		} catch (error) {
			if (!(error instanceof Error)) throw error
			return error.name === 'LivePersonRequiredError'
				? error.name
				: error.message
		}
	}
	const tryAll = async (callerContext: McpCallerContext) => {
		const siteAdmin: Record<string, string> = {}
		for (const [name, call] of Object.entries(siteAdminCalls)) {
			siteAdmin[name] = await outcomeOf(() => call(callerContext))
		}
		attempts.push({
			credential: callerContext.request?.credential.kind,
			roleChange: await outcomeOf(() => roleChange(callerContext)),
			siteAdmin,
		})
	}
	t.setPackageCode(tryAll)

	await t.enable('owner', 'subscription', emailTopic)
	await t.enableWebhook('owner', 'endpoint-owner')
	await t.enable('owner', 'cron', jobName)
	await t.sendEmail('owner@acme.example')
	await t.deliverWebhook('endpoint-owner')
	const jobId = buildPackageJobId('pkg-shared', jobName)
	const plan = await planEnablementRuns({
		env: t.env,
		orgId: t.orgId,
		packageId: 'pkg-shared',
		trigger: { kind: 'cron', instanceId: jobId },
	})
	expect(plan.runs).toHaveLength(1)
	await tryAll(
		createMcpCallerContext({
			baseUrl: 'https://kody.example',
			user: {
				...plan.runs[0]!.enabler,
				email: 'owner@acme.example',
				displayName: 'owner',
				roles: ['admin'],
			},
			source: { kind: 'schedule', jobId, enablement: plan.runs[0] },
			orgBinding: {
				org: { id: t.orgId, slug: 'quillworks' },
				role: plan.runs[0]!.role,
			},
		}),
	)
	// Enablement-backed team-org runs defer site-admin role checks to the
	// enabler in D1, so email/webhook/schedule all reach site-admin tools when
	// the Owner is a site admin. Role changes still need a live person.
	const siteAdminOk = {
		adminCreditGrant: 'ok',
		adminUserUpdate: 'ok',
		adminFeatureFlagSet: 'ok',
	}
	expect(attempts).toEqual([
		{
			credential: 'inbound-email',
			roleChange: 'LivePersonRequiredError',
			siteAdmin: siteAdminOk,
		},
		{
			credential: 'webhook',
			roleChange: 'LivePersonRequiredError',
			siteAdmin: siteAdminOk,
		},
		{
			credential: 'schedule',
			roleChange: 'LivePersonRequiredError',
			siteAdmin: siteAdminOk,
		},
	])
	expect(t.runs.map((run) => run.request?.actor?.userId)).toEqual([
		t.people.owner.userId,
		t.people.owner.userId,
	])
	const roleOf = async (person: 'bea' | 'owner') =>
		(
			await t.db
				.prepare(
					`SELECT role FROM org_memberships
					 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
				)
				.bind(t.orgId, t.people[person].userId)
				.first<{ role: string }>()
		)?.role
	expect(await roleOf('bea')).toBe('member')

	// The same Owner, live in a web session, may change the role.
	await roleChange(
		createMcpCallerContext({
			baseUrl: 'https://kody.example',
			user: {
				...t.people.owner,
				email: 'owner@acme.example',
				displayName: 'owner',
			},
			source: { kind: 'session' },
			orgBinding: { org: { id: t.orgId, slug: 'quillworks' }, role: 'owner' },
		}),
	)
	expect(await roleOf('bea')).toBe('owner')
})
