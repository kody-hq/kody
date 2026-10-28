import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'

const mocks = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	loadProfileData: vi.fn(),
	loadOrgRepositoriesData: vi.fn(),
	loadAccountActivityData: vi.fn(),
	loadAccountJobsData: vi.fn(),
	loadWorkspaceRunCharts: vi.fn(),
	loadOrgUsagePageResult: vi.fn(),
}))

vi.mock('#app/skill-metrics.ts', () => ({
	loadSkillMetrics: vi.fn().mockResolvedValue({
		skillCount: 0,
		packageCount: 0,
		instructionReads: 0,
		supportingFileReads: 0,
		readers: 0,
		since: '2026-01-01',
		topSkills: [],
		dailyReads: [],
		skillActivity: [],
		recentReads: [],
	}),
}))
vi.mock('#worker/run-records/service.ts', () => ({
	loadWorkspaceRunCharts: mocks.loadWorkspaceRunCharts,
}))
vi.mock('#app/handlers/org-usage.ts', () => ({
	loadOrgUsagePageResult: mocks.loadOrgUsagePageResult,
}))
vi.mock('#app/org-repositories-data.ts', () => ({
	loadOrgRepositoriesData: mocks.loadOrgRepositoriesData,
}))
vi.mock('#app/profile-data.ts', () => ({
	loadProfileData: mocks.loadProfileData,
}))
vi.mock('#app/account-activity-data.ts', () => ({
	loadAccountActivityData: mocks.loadAccountActivityData,
}))
vi.mock('#app/account-jobs-data.ts', () => ({
	loadAccountJobsData: mocks.loadAccountJobsData,
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mocks.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: async () =>
		(await mocks.readAuthenticatedAppUser()) ??
		Response.redirect('https://kody.test/login', 302),
}))
const native = vi.hoisted(() => ({
	env: {} as Env,
	request: new Request('https://example.com/login'),
	setResponseHeader: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerOnlyFn: <T>(fn: T) => fn,
	createServerFn: () => {
		let validate:
			| ((data: unknown) => unknown)
			| { parse(data: unknown): unknown } = (data) => data
		const builder = {
			validator: (fn: typeof validate) => {
				validate = fn
				return builder
			},
			handler:
				(fn: (input: { data: unknown }) => unknown) =>
				(input: { data: unknown }) =>
					fn({
						data:
							typeof validate === 'function'
								? validate(input.data)
								: validate.parse(input.data),
					}),
		}
		return builder
	},
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	get env() {
		return native.env
	},
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => native.request,
	setResponseHeader: native.setResponseHeader,
}))
vi.mock('#app/env.ts', () => ({ getEnv: () => native.env }))

const { loadOrgOverview } =
	await import('../../../start/server/org-management.ts')

const adaId = 'person-ada'
const bobId = 'person-bob'

async function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	const now = '2026-01-01T00:00:00.000Z'
	for (const [id, slug] of [
		[adaId, 'ada'],
		[bobId, 'bob'],
		['org-acme', 'acme'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(id, slug, slug, now, now)
	}
	for (const [orgId, userId] of [
		[adaId, adaId],
		[bobId, bobId],
		['org-acme', adaId],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?)`,
			)
			.run(orgId, userId, now)
	}
	return {
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
	} as unknown as Env
}

async function getOverview(env: Env, orgSlug: string) {
	native.env = env
	native.request = new Request(`https://kody.test/@${orgSlug}/-/overview`)
	return loadOrgOverview({ data: { slug: orgSlug } })
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.loadWorkspaceRunCharts.mockResolvedValue({
		since: '2026-01-01T00:00:00.000Z',
		until: '2026-01-07T12:00:00.000Z',
		countsSince: null,
		days: [],
		sources: [],
	})
	mocks.loadOrgUsagePageResult.mockResolvedValue({
		kind: 'denied',
		status: 403,
	})
	mocks.loadProfileData.mockResolvedValue({ packages: [] })
	mocks.loadOrgRepositoriesData.mockResolvedValue({ packages: [] })
	mocks.loadAccountActivityData.mockResolvedValue({
		summary: {
			since: '2025-12-31T12:00:00.000Z',
			total: 0,
			errors: 0,
			running: 0,
			ignored: 0,
			resolved: 0,
		},
		runs: [],
	})
	mocks.loadAccountJobsData.mockResolvedValue({ jobs: [] })
	mocks.readAuthenticatedAppUser.mockReset()
	native.setResponseHeader.mockClear()
	mocks.readAuthenticatedAppUser.mockResolvedValue({
		username: 'ada-renamed',
		mcpUser: { userId: adaId },
	})
})

test('signed-out visitors go to login', async () => {
	mocks.readAuthenticatedAppUser.mockResolvedValue(null)
	await expect(getOverview(await createEnv(), 'ada')).rejects.toMatchObject({
		options: { href: expect.stringContaining('/login') },
	})
})

test('the signup org overview renders without remembering the org', async () => {
	const overview = await getOverview(await createEnv(), 'ada')
	expect(overview.slug).toBe('ada')
	expect(native.setResponseHeader).toHaveBeenCalledWith(
		'Cache-Control',
		'private, no-store',
	)
})
test.each(['owner', 'member', 'billing'])(
	'a team org %s gets a dashboard scoped to the org',
	async (role) => {
		const env = await createEnv()
		await env.APP_DB.prepare(
			'UPDATE org_memberships SET role = ? WHERE org_id = ?',
		)
			.bind(role, 'org-acme')
			.run()
		mocks.loadOrgRepositoriesData.mockResolvedValue({
			packages: [{ kodyId: 'team-repo' }],
		})
		const result = await getOverview(env, 'acme')
		expect(result.slug).toBe('acme')
		expect(result.repositories).toEqual([{ kodyId: 'team-repo' }])
		expect(mocks.loadProfileData).not.toHaveBeenCalled()
		expect(mocks.loadOrgRepositoriesData).toHaveBeenCalledWith(
			expect.objectContaining({
				binding: expect.objectContaining({
					org: expect.objectContaining({ id: 'org-acme' }),
				}),
				query: '',
				limit: 5,
			}),
		)
		for (const reader of [
			mocks.loadAccountActivityData,
			mocks.loadAccountJobsData,
			mocks.loadOrgUsagePageResult,
		]) {
			expect(reader).toHaveBeenCalledWith(
				expect.objectContaining({
					user: expect.objectContaining({
						request: expect.objectContaining({
							org: expect.objectContaining({ id: 'org-acme' }),
						}),
					}),
				}),
			)
		}
		expect(mocks.loadWorkspaceRunCharts).toHaveBeenCalledWith({
			env,
			userId: 'org-acme',
		})
	},
)
test('an org you do not belong to is a 404', async () => {
	await expect(getOverview(await createEnv(), 'bob')).rejects.toMatchObject({
		isNotFound: true,
	})
	expect(mocks.loadProfileData).not.toHaveBeenCalled()
	expect(mocks.loadAccountActivityData).not.toHaveBeenCalled()
	expect(mocks.loadAccountJobsData).not.toHaveBeenCalled()
})
test('grant-only collaborators cannot read the org dashboard', async () => {
	const env = await createEnv()
	await env.APP_DB.prepare('DELETE FROM org_memberships WHERE org_id = ?')
		.bind('org-acme')
		.run()
	await env.APP_DB.prepare(`INSERT INTO grants (
		id, org_id, resource_type, resource_id, subject_type, subject_id,
		preset, created_by_user_id, created_at, updated_at
	) VALUES ('grant-ada', 'org-acme', 'package', 'pkg-shared', 'user', ?,
		'use', ?, '2026-01-01', '2026-01-01')`)
		.bind(adaId, bobId)
		.run()
	await expect(getOverview(env, 'acme')).rejects.toMatchObject({
		isNotFound: true,
	})
	expect(mocks.loadProfileData).not.toHaveBeenCalled()
	expect(mocks.loadOrgRepositoriesData).not.toHaveBeenCalled()
	expect(mocks.loadAccountActivityData).not.toHaveBeenCalled()
	expect(mocks.loadAccountJobsData).not.toHaveBeenCalled()
	expect(mocks.loadWorkspaceRunCharts).not.toHaveBeenCalled()
	expect(mocks.loadOrgUsagePageResult).not.toHaveBeenCalled()
})

test('dashboard shows only runnable jobs, soonest first, and caps activity', async () => {
	const job = { enabled: true, killSwitchEnabled: false, expired: false }
	mocks.loadAccountJobsData.mockResolvedValue({
		jobs: [
			{ ...job, id: 'later', nextRunAt: '2026-10-23T10:00:00Z' },
			{
				...job,
				id: 'paused',
				enabled: false,
				nextRunAt: '2026-10-20T10:00:00Z',
			},
			{
				...job,
				id: 'stopped',
				killSwitchEnabled: true,
				nextRunAt: '2026-10-20T10:00:00Z',
			},
			{
				...job,
				id: 'expired',
				expired: true,
				nextRunAt: '2026-10-20T10:00:00Z',
			},
			{ ...job, id: 'next', nextRunAt: '2026-10-22T10:00:00Z' },
		],
	})
	mocks.loadAccountActivityData.mockResolvedValue({
		summary: {
			since: '2025-12-31T12:00:00.000Z',
			total: 99,
			errors: 3,
			running: 1,
			ignored: 0,
			resolved: 0,
		},
		runs: Array.from({ length: 12 }, (_, i) => ({ id: String(i) })),
	})
	mocks.loadWorkspaceRunCharts.mockResolvedValue({
		since: '2026-01-01T00:00:00.000Z',
		until: '2026-01-07T12:00:00.000Z',
		countsSince: '2026-01-03',
		days: [
			{ day: '2026-01-01', success: 0, error: 0, running: 0 },
			{ day: '2026-01-02', success: 0, error: 0, running: 0 },
			{ day: '2026-01-03', success: 10, error: 2, running: 0 },
			{ day: '2026-01-04', success: 0, error: 0, running: 0 },
			{ day: '2026-01-05', success: 0, error: 0, running: 0 },
			{ day: '2026-01-06', success: 0, error: 0, running: 0 },
			{ day: '2026-01-07', success: 0, error: 0, running: 0 },
		],
		sources: [{ surface: 'execute', count: 12 }],
	})
	const result = await getOverview(await createEnv(), 'ada')
	expect(result.upcomingJobs.map((job) => job.id)).toEqual(['next', 'later'])
	expect(result.runs).toHaveLength(6)
	// Total/Running come from charts; Open errors stays Activity untriaged.
	expect(result.summary).toMatchObject({
		since: '2026-01-01T00:00:00.000Z',
		total: 12,
		running: 0,
		errors: 3,
	})
	expect(mocks.loadProfileData).toHaveBeenCalledWith(
		expect.anything(),
		expect.anything(),
		'ada-renamed',
		undefined,
		{ query: '', limit: 5 },
	)
})

test('dashboard uses the scoped billing reader and returns only dashboard fields', async () => {
	mocks.loadOrgUsagePageResult.mockResolvedValue({
		kind: 'data',
		payload: {
			whereItWent: { rows: [] },
			includedCompute: [],
			creditsAlarm: null,
			privateExtra: 'not-needed',
		},
	})
	const result = await getOverview(await createEnv(), 'ada')
	expect(result.billing).toEqual({
		whereItWent: { rows: [] },
		includedCompute: [],
		creditsAlarm: null,
	})
	expect(mocks.loadOrgUsagePageResult).toHaveBeenCalledWith(
		expect.objectContaining({
			orgSlug: 'ada',
			user: expect.objectContaining({
				request: expect.objectContaining({
					org: expect.objectContaining({ id: adaId }),
				}),
			}),
		}),
	)
	expect(mocks.loadWorkspaceRunCharts).toHaveBeenCalledWith(
		expect.objectContaining({ userId: adaId }),
	)
})
