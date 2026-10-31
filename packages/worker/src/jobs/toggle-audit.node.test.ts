import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { expect, test } from 'vitest'
import { applyMigrations } from '#worker/test-support/account-export.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	automationToggleActor,
	listToggleAudit,
	manualDisabledReason,
	nextDisabledReason,
	normalizeToggleReason,
	recordToggleAudit,
	toggleActorFromRequest,
	toggleSourceFromRequest,
} from './toggle-audit.ts'

const orgId = ownerIdFromStored('org-toggle')

function createEnv(withAudit = true) {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrations(sqlite)
	return {
		APP_DB: createD1FromSqlite(sqlite),
		...(withAudit ? { AUDIT_DB: createAuditTestDb() } : {}),
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
}

function request(
	overrides: Partial<RequestContext> & {
		credentialKind?: RequestContext['credential']['kind']
	} = {},
): RequestContext {
	const { credentialKind = 'mcp-oauth', ...rest } = overrides
	return {
		org: { id: orgId, slug: 'acme' },
		actor: { userId: personIdFromStored('person-ann'), username: 'ann' },
		attribution: { kind: 'user', userId: personIdFromStored('person-ann') },
		credential: {
			kind: credentialKind,
			id: 'cred-1',
			orgId,
			scopes: null,
		},
		membership: { role: 'owner' },
		...rest,
	}
}

test('the source surface comes from the credential kind', () => {
	expect(toggleSourceFromRequest(request({ credentialKind: 'session' }))).toBe(
		'web',
	)
	expect(toggleSourceFromRequest(request())).toBe('mcp')
	expect(
		toggleSourceFromRequest(request({ credentialKind: 'api-token' })),
	).toBe('api')
	expect(toggleSourceFromRequest(request({ credentialKind: 'cli' }))).toBe(
		'cli',
	)
	expect(toggleSourceFromRequest(request({ credentialKind: 'schedule' }))).toBe(
		'automation',
	)
	expect(toggleSourceFromRequest(null)).toBe('automation')
})

test('the actor is a person, an automation run, or a site admin outside the org', () => {
	expect(toggleActorFromRequest(request())).toMatchObject({
		kind: 'person',
		username: 'ann',
		credentialKind: 'mcp-oauth',
	})
	expect(
		toggleActorFromRequest(
			request({
				attribution: {
					kind: 'automation',
					source: 'schedule',
					sourceId: 'job-1',
				},
			}),
		).kind,
	).toBe('automation')
	expect(
		toggleActorFromRequest(request({ membership: null }), { siteAdmin: true })
			.kind,
	).toBe('admin')
	// An Owner who is also a site admin is acting as an Owner.
	expect(toggleActorFromRequest(request(), { siteAdmin: true }).kind).toBe(
		'person',
	)
	expect(toggleActorFromRequest(null)).toEqual(automationToggleActor())
})

test('reasons are trimmed, blank reasons dropped, long reasons capped', () => {
	expect(normalizeToggleReason('  flaky API  ')).toBe('flaky API')
	expect(normalizeToggleReason('   ')).toBeNull()
	expect(normalizeToggleReason(undefined)).toBeNull()
	expect(normalizeToggleReason('x'.repeat(900))).toHaveLength(500)
})

test('a job toggle is recorded and listed newest first, filtered by job', async () => {
	const env = createEnv()
	await recordToggleAudit({
		env,
		orgId,
		resource: 'job',
		resourceId: 'pkg:daily',
		name: 'daily',
		from: 'on',
		to: 'off',
		source: 'scheduler',
		actor: automationToggleActor(),
		reason: 'Kody could not compute the next run.',
	})
	await recordToggleAudit({
		env,
		orgId,
		resource: 'job',
		resourceId: 'pkg:other',
		from: 'off',
		to: 'on',
		source: 'mcp',
		actor: toggleActorFromRequest(request()),
	})
	const all = await listToggleAudit({ env, orgId })
	expect(all).toHaveLength(2)
	const daily = await listToggleAudit({ env, orgId, jobId: 'pkg:daily' })
	expect(daily).toEqual([
		expect.objectContaining({
			resource: 'job',
			resourceId: 'pkg:daily',
			from: 'on',
			to: 'off',
			source: 'scheduler',
			actorKind: 'automation',
			actorUsername: null,
			reason: 'Kody could not compute the next run.',
			jobId: 'pkg:daily',
			name: 'daily',
		}),
	])
	expect(
		await listToggleAudit({ env, orgId: ownerIdFromStored('org-other') }),
	).toEqual([])
})

test('no change, or no audit database, records nothing and never throws', async () => {
	const env = createEnv()
	expect(
		await recordToggleAudit({
			env,
			orgId,
			resource: 'job',
			resourceId: 'pkg:daily',
			from: 'on',
			to: 'on',
			source: 'mcp',
			actor: automationToggleActor(),
		}),
	).toBe(false)
	const noAudit = createEnv(false)
	expect(
		await recordToggleAudit({
			env: noAudit,
			orgId,
			resource: 'job',
			resourceId: 'pkg:daily',
			from: 'on',
			to: 'off',
			source: 'mcp',
			actor: automationToggleActor(),
		}),
	).toBe(false)
	expect(await listToggleAudit({ env: noAudit, orgId })).toEqual([])
})

test('nextDisabledReason keeps the job explanation in step with its on/off state', () => {
	const fallback = manualDisabledReason('web')
	expect(
		nextDisabledReason({
			wasEnabled: true,
			enabled: false,
			previousReason: null,
			reason: '  Too noisy  ',
			fallback,
		}),
	).toBe('Too noisy')
	expect(
		nextDisabledReason({
			wasEnabled: true,
			enabled: false,
			previousReason: null,
			reason: undefined,
			fallback,
		}),
	).toBe(fallback)
	expect(
		nextDisabledReason({
			wasEnabled: false,
			enabled: false,
			previousReason: 'Old reason',
			reason: undefined,
			fallback,
		}),
	).toBe('Old reason')
	expect(
		nextDisabledReason({
			wasEnabled: false,
			enabled: false,
			previousReason: 'Old reason',
			reason: 'New reason',
			fallback,
		}),
	).toBe('New reason')
	expect(
		nextDisabledReason({
			wasEnabled: false,
			enabled: true,
			previousReason: 'Old reason',
			reason: 'ignored',
			fallback,
		}),
	).toBeNull()
})
