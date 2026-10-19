import { DatabaseSync } from 'node:sqlite'
import { type OrgGrantResourceType } from '@kody-internal/shared/org-permissions.ts'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import type * as MemoryService from '#mcp/memory/service.ts'
import type * as SecretService from '#mcp/secrets/service.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { AuthorizationError } from './authorize.ts'

const mocks = vi.hoisted(() => ({
	getMemory: vi.fn(),
	deleteMemory: vi.fn(),
	searchMemoryRecords: vi.fn(),
	inspectJobsForUser: vi.fn(),
	getJobInspection: vi.fn(),
	listRunRecords: vi.fn(),
	getRunRecord: vi.fn(),
	listIntegrations: vi.fn(),
	getIntegration: vi.fn(),
	deleteIntegration: vi.fn(),
	listSecrets: vi.fn(),
	findSecret: vi.fn(),
	deleteSecret: vi.fn(),
	saveSecret: vi.fn(),
	findIntegrationCredentialId: vi.fn(),
}))

vi.mock('#mcp/memory/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MemoryService>()
	return {
		...actual,
		getMemory: (...args: Array<unknown>) => mocks.getMemory(...args),
		deleteMemory: (...args: Array<unknown>) => mocks.deleteMemory(...args),
		searchMemoryRecords: (...args: Array<unknown>) =>
			mocks.searchMemoryRecords(...args),
	}
})

vi.mock('#worker/jobs/inspect.ts', () => ({
	inspectJobsForUser: (...args: Array<unknown>) =>
		mocks.inspectJobsForUser(...args),
	getJobInspection: (...args: Array<unknown>) =>
		mocks.getJobInspection(...args),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	listRunRecords: (...args: Array<unknown>) => mocks.listRunRecords(...args),
	getRunRecord: (...args: Array<unknown>) => mocks.getRunRecord(...args),
}))

vi.mock('#worker/integrations/service.ts', () => ({
	listIntegrations: (...args: Array<unknown>) =>
		mocks.listIntegrations(...args),
	getIntegration: (...args: Array<unknown>) => mocks.getIntegration(...args),
	deleteIntegration: (...args: Array<unknown>) =>
		mocks.deleteIntegration(...args),
}))

vi.mock('#worker/integrations/credentials.ts', () => ({
	findIntegrationCredentialId: (...args: Array<unknown>) =>
		mocks.findIntegrationCredentialId(...args),
}))

vi.mock('#mcp/secrets/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof SecretService>()
	return {
		...actual,
		listSecrets: (...args: Array<unknown>) => mocks.listSecrets(...args),
		findSecret: (...args: Array<unknown>) => mocks.findSecret(...args),
		deleteSecret: (...args: Array<unknown>) => mocks.deleteSecret(...args),
		saveSecret: (...args: Array<unknown>) => mocks.saveSecret(...args),
	}
})

const { metaMemorySearchCapability } =
	await import('#mcp/capabilities/meta/meta-memory-search.ts')
const { metaMemoryGetCapability } =
	await import('#mcp/capabilities/meta/meta-memory-get.ts')
const { metaMemoryDeleteCapability } =
	await import('#mcp/capabilities/meta/meta-memory-delete.ts')
const { jobListCapability } = await import('#mcp/capabilities/jobs/job-list.ts')
const { jobGetCapability } = await import('#mcp/capabilities/jobs/job-get.ts')
const { runListCapability } = await import('#mcp/capabilities/runs/run-list.ts')
const { runGetCapability } = await import('#mcp/capabilities/runs/run-get.ts')
const { integrationListCapability } =
	await import('#mcp/capabilities/integrations/integration-list.ts')
const { integrationGetCapability } =
	await import('#mcp/capabilities/integrations/integration-get.ts')
const { integrationDeleteCapability } =
	await import('#mcp/capabilities/integrations/integration-delete.ts')

const { secretListCapability } =
	await import('#mcp/capabilities/secrets/secret-list.ts')
const { secretDeleteCapability } =
	await import('#mcp/capabilities/secrets/secret-delete.ts')
const { secretSetCapability } =
	await import('#mcp/capabilities/secrets/secret-set.ts')

const grantedMemoryId = 'memory-granted'
const otherMemoryId = 'memory-other'
const grantedJobId = 'job-granted'
const otherJobId = 'job-other'
const grantedIntegration = 'github'
const otherIntegration = 'linear'
const grantedSecret = 'shared-api-key'
const otherSecret = 'private-api-key'
const credentialIdOf = (name: string) => `cred-${name}`

async function seedGrant(input: {
	db: D1Database
	orgId: string
	subjectId: string
	resourceType: OrgGrantResourceType
	resourceId: string
	permissions: Array<string>
}) {
	const now = new Date().toISOString()
	const grantId = crypto.randomUUID()
	await input.db
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'user', ?, 'use', ?, ?, ?)`,
		)
		.bind(
			grantId,
			input.orgId,
			input.resourceType,
			input.resourceId,
			input.subjectId,
			input.orgId,
			now,
			now,
		)
		.run()
	for (const permission of input.permissions) {
		await input.db
			.prepare(
				`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
			)
			.bind(grantId, permission)
			.run()
	}
}

/**
 * An org Owner and a grant-only collaborator (no membership) holding Use on
 * one memory, one job, and one integration, and Use/Write/Delete on one secret.
 */
async function setup() {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	await ensureOrgsTestSchema(db)
	const ownerId = testStableUserIdFromEmail('owner@example.com')
	const ownerSlug = `u${ownerId.slice(0, 8)}`
	await provisionPersonalOrg(db, { stableUserId: ownerId, username: ownerSlug })
	const collaboratorId = testStableUserIdFromEmail('guest@example.com')
	await seedGrant({
		db,
		orgId: ownerId,
		subjectId: collaboratorId,
		resourceType: 'memory',
		resourceId: grantedMemoryId,
		permissions: ['memory:read'],
	})
	await seedGrant({
		db,
		orgId: ownerId,
		subjectId: collaboratorId,
		resourceType: 'job',
		resourceId: grantedJobId,
		permissions: ['job:read', 'job:execute'],
	})
	await seedGrant({
		db,
		orgId: ownerId,
		subjectId: collaboratorId,
		resourceType: 'credential',
		resourceId: credentialIdOf(grantedIntegration),
		permissions: ['integration:use', 'integration:read'],
	})
	await seedGrant({
		db,
		orgId: ownerId,
		subjectId: collaboratorId,
		resourceType: 'credential',
		resourceId: credentialIdOf(grantedSecret),
		permissions: ['secret:use', 'secret:write', 'secret:delete'],
	})
	const env = { APP_DB: db } as unknown as Env
	function contextFor(input: { userId: string; role: 'owner' | null }) {
		return {
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://kody.example',
				user: {
					userId: personIdFromStored(input.userId),
					email: `${input.userId}@example.com`,
					displayName: 'Person',
				},
				orgBinding: {
					org: { id: ownerIdFromStored(ownerId), slug: ownerSlug },
					role: input.role,
				},
			}),
		}
	}
	return {
		owner: contextFor({ userId: ownerId, role: 'owner' }),
		collaborator: contextFor({ userId: collaboratorId, role: null }),
	}
}

function memoryRecord(id: string) {
	return {
		id,
		category: null,
		status: 'active' as const,
		subject: `Subject ${id}`,
		summary: `Summary ${id}`,
		details: '',
		tags: [],
		sourceUris: [],
		dedupeKey: null,
		createdAt: '2026-10-01T00:00:00.000Z',
		updatedAt: '2026-10-01T00:00:00.000Z',
		lastAccessedAt: null,
		deletedAt: null,
	}
}

function job(id: string) {
	return {
		id,
		name: `Job ${id}`,
		sourceId: `source-${id}`,
		publishedCommit: null,
		storageId: `job:${id}`,
		schedule: { type: 'interval', every: '15m' },
		scheduleSummary: 'Runs every 15m',
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		preserved: false,
		expiresAt: null,
		createdAt: '2026-10-01T00:00:00.000Z',
		updatedAt: '2026-10-01T00:00:00.000Z',
		nextRunAt: '2026-10-12T00:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
	}
}

function integration(name: string) {
	return {
		name,
		credentialId: credentialIdOf(name),
		tokenUrl: `https://${name}.example/oauth/token`,
		flow: 'pkce' as const,
		clientId: `${name}-client`,
	}
}

function secret(name: string) {
	return {
		name,
		credentialId: credentialIdOf(name),
		scope: 'user' as const,
		description: '',
		packageId: null,
		allowedHosts: [],
		allowedPackages: [],
		createdAt: '2026-10-01T00:00:00.000Z',
		updatedAt: '2026-10-01T00:00:00.000Z',
		expiresAt: null,
		ttlMs: null,
		placement: null,
	}
}

const alarm = {
	bindingAvailable: true,
	status: 'armed',
	storedUserId: 'org',
	alarmScheduledFor: null,
	nextRunnableJobId: null,
	nextRunnableRunAt: null,
	alarmInSync: true,
}

test('memory tools always use the caller personal org (ADR 0072), even on a foreign org binding', async () => {
	const { owner, collaborator } = await setup()
	// Collaborator needs a live personal org so authorize against personal works.
	const collaboratorPersonId = collaborator.callerContext.user!.userId
	const ownerPersonId = owner.callerContext.user!.userId
	await provisionPersonalOrg(collaborator.env.APP_DB, {
		stableUserId: collaboratorPersonId,
		username: `g${collaboratorPersonId.slice(0, 7)}`,
	})
	mocks.searchMemoryRecords.mockResolvedValue({
		query: 'q',
		matches: [],
		suppressedCount: 0,
	})

	await metaMemorySearchCapability.handler(
		{ query: 'q', limit: 5 },
		collaborator,
	)
	expect(mocks.searchMemoryRecords).toHaveBeenLastCalledWith(
		expect.objectContaining({
			userId: personalOrgId(collaboratorPersonId),
			scope: { kind: 'all' },
		}),
	)

	await metaMemorySearchCapability.handler({ query: 'q', limit: 5 }, owner)
	expect(mocks.searchMemoryRecords).toHaveBeenLastCalledWith(
		expect.objectContaining({
			userId: personalOrgId(ownerPersonId),
			scope: { kind: 'all' },
		}),
	)

	mocks.getMemory.mockResolvedValueOnce(memoryRecord(grantedMemoryId))
	const got = await metaMemoryGetCapability.handler(
		{ memory_id: grantedMemoryId },
		collaborator,
	)
	expect(got?.id).toBe(grantedMemoryId)
	expect(mocks.getMemory).toHaveBeenLastCalledWith(
		expect.objectContaining({
			userId: personalOrgId(collaboratorPersonId),
		}),
	)

	await expect(
		metaMemoryDeleteCapability.handler(
			{ memory_id: otherMemoryId, verified_by_agent: true },
			collaborator,
		),
	).rejects.toThrow()
	expect(mocks.deleteMemory).not.toHaveBeenCalled()
})

test('job list and get return only the granted job to a collaborator', async () => {
	const { owner, collaborator } = await setup()
	const otherJobAlarm = {
		...alarm,
		alarmScheduledFor: '2026-10-12T00:00:00.000Z',
		nextRunnableJobId: otherJobId,
		nextRunnableRunAt: '2026-10-12T00:00:00.000Z',
	}
	mocks.inspectJobsForUser.mockResolvedValue({
		jobs: [job(grantedJobId), job(otherJobId)],
		alarm: otherJobAlarm,
	})
	mocks.getJobInspection.mockImplementation(
		async (input: { jobId: string }) => ({ job: job(input.jobId), alarm }),
	)
	mocks.listRunRecords.mockResolvedValue({ runs: [], nextCursor: null })

	const listed = await jobListCapability.handler({}, collaborator)
	expect(listed.jobs.map((entry) => entry.id)).toEqual([grantedJobId])
	expect(listed.alarm).toMatchObject({
		alarm_scheduled_for: null,
		next_runnable_job_id: null,
		next_runnable_run_at: null,
	})
	const ownerListed = await jobListCapability.handler({}, owner)
	expect(ownerListed.jobs.map((entry) => entry.id)).toEqual([
		grantedJobId,
		otherJobId,
	])
	expect(ownerListed.alarm.next_runnable_job_id).toBe(otherJobId)

	await expect(
		jobGetCapability.handler({ id: otherJobId }, collaborator),
	).rejects.toBeInstanceOf(AuthorizationError)
	const got = await jobGetCapability.handler({ id: grantedJobId }, collaborator)
	expect(got.job.id).toBe(grantedJobId)
})

test('run history needs org-wide job:read unless scoped to a granted job', async () => {
	const { owner, collaborator } = await setup()
	mocks.listRunRecords.mockResolvedValue({ runs: [], nextCursor: null })

	await expect(
		runListCapability.handler({}, collaborator),
	).rejects.toBeInstanceOf(AuthorizationError)
	await expect(
		runListCapability.handler({ job_id: otherJobId }, collaborator),
	).rejects.toBeInstanceOf(AuthorizationError)
	await runListCapability.handler({ job_id: grantedJobId }, collaborator)
	expect(mocks.listRunRecords).toHaveBeenLastCalledWith(
		expect.objectContaining({
			filter: expect.objectContaining({ jobId: grantedJobId }),
		}),
	)
	await runListCapability.handler({}, owner)

	mocks.getRunRecord.mockResolvedValue({
		run: { id: 'run-1', jobId: otherJobId },
		logs: [],
	})
	await expect(
		runGetCapability.handler({ run_id: 'run-1' }, collaborator),
	).rejects.toBeInstanceOf(AuthorizationError)
})

test('integration list, get, and delete honor per-integration grants', async () => {
	const { owner, collaborator } = await setup()
	mocks.listIntegrations.mockResolvedValue([
		integration(grantedIntegration),
		integration(otherIntegration),
	])
	mocks.getIntegration.mockImplementation(async (input: { name: string }) =>
		integration(input.name),
	)
	mocks.findIntegrationCredentialId.mockImplementation(
		async (input: { name: string }) => credentialIdOf(input.name),
	)

	const listed = await integrationListCapability.handler({}, collaborator)
	expect(listed.integrations.map((entry) => entry.name)).toEqual([
		grantedIntegration,
	])
	const ownerListed = await integrationListCapability.handler({}, owner)
	expect(ownerListed.integrations).toHaveLength(2)

	await expect(
		integrationGetCapability.handler({ name: otherIntegration }, collaborator),
	).rejects.toBeInstanceOf(AuthorizationError)
	const got = await integrationGetCapability.handler(
		{ name: grantedIntegration },
		collaborator,
	)
	expect(got.integration?.name).toBe(grantedIntegration)

	await expect(
		integrationDeleteCapability.handler(
			{ name: grantedIntegration },
			collaborator,
		),
	).rejects.toBeInstanceOf(AuthorizationError)
	expect(mocks.deleteIntegration).not.toHaveBeenCalled()
})

test('secret list, delete, and set honor per-secret grants', async () => {
	const { owner, collaborator } = await setup()
	mocks.listSecrets.mockResolvedValue([
		secret(grantedSecret),
		secret(otherSecret),
	])
	mocks.findSecret.mockImplementation(async (input: { name: string }) =>
		input.name === 'new-secret'
			? {
					found: false,
					credentialId: null,
					scope: null,
					allowedHosts: [],
					allowedPackages: [],
				}
			: {
					found: true,
					credentialId: credentialIdOf(input.name),
					scope: 'user',
					allowedHosts: [],
					allowedPackages: [],
				},
	)

	const listed = await secretListCapability.handler({}, collaborator)
	expect(listed.secrets.map((entry) => entry.name)).toEqual([grantedSecret])
	const ownerListed = await secretListCapability.handler({}, owner)
	expect(ownerListed.secrets).toHaveLength(2)

	await expect(
		secretDeleteCapability.handler(
			{ name: otherSecret, scope: 'user' },
			collaborator,
		),
	).rejects.toBeInstanceOf(AuthorizationError)
	expect(mocks.deleteSecret).not.toHaveBeenCalled()
	mocks.deleteSecret.mockResolvedValue(true)
	await expect(
		secretDeleteCapability.handler(
			{ name: grantedSecret, scope: 'user' },
			collaborator,
		),
	).resolves.toEqual({ deleted: true })

	await expect(
		secretSetCapability.handler(
			{ name: otherSecret, value: 'overwrite', scope: 'user' },
			collaborator,
		),
	).rejects.toBeInstanceOf(AuthorizationError)
	await expect(
		secretSetCapability.handler(
			{ name: `  ${otherSecret}  `, value: 'overwrite', scope: 'user' },
			collaborator,
		),
	).rejects.toBeInstanceOf(AuthorizationError)
	expect(mocks.findSecret).toHaveBeenLastCalledWith(
		expect.objectContaining({ name: otherSecret, includeExpired: true }),
	)
	await expect(
		secretSetCapability.handler(
			{ name: 'new-secret', value: 'value', scope: 'user' },
			collaborator,
		),
	).rejects.toBeInstanceOf(AuthorizationError)
	expect(mocks.saveSecret).not.toHaveBeenCalled()
})
