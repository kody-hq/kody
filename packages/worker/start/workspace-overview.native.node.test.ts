import { createElement, type ComponentProps } from 'react'
import { expect, test } from 'vitest'
import { WorkspaceOverview } from './pages/workspace-overview.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'

type Data = ComponentProps<typeof WorkspaceOverview>['data']
const empty: Data = {
	slug: 'jane',
	charts: {
		since: '2026-10-15T00:00:00Z',
		until: '2026-10-21T12:00:00Z',
		days: [],
		sources: [],
	},
	billing: null,
	repositories: [],
	runs: [],
	upcomingJobs: [],
	summary: {
		since: '2026-10-14T00:00:00Z',
		total: 0,
		errors: 0,
		running: 0,
		ignored: 0,
		resolved: 0,
	},
}

test('empty dashboard explains missing work and offers agent setup', async () => {
	const html = await renderStartPage(
		createElement(WorkspaceOverview, { data: empty }),
	)
	expect(html).toContain('No repositories yet.')
	expect(html).toContain('No executions in the last 7 days.')
	expect(html).toContain('No jobs scheduled.')
	expect(html).toContain('href="/@jane/-/agents"')
})

test('dashboard links real activity and scheduled jobs to their details', async () => {
	const data: Data = {
		...empty,
		summary: { ...empty.summary, total: 42, errors: 2 },
		runs: [
			{
				id: 'run-1',
				surface: 'execute',
				status: 'error',
				name: 'Sync contacts',
				startedAt: '2026-10-21T10:00:00Z',
				finishedAt: null,
				durationMs: null,
				errorName: 'Error',
				errorMessage: 'Failed',
				errorTriage: null,
				packageId: null,
				jobId: null,
				logCount: 1,
				idempotencyKey: null,
				entry: null,
				workerId: null,
			},
		],
		upcomingJobs: [
			{
				id: 'job-1',
				name: 'Daily sync',
				packageId: 'pkg-1',
				packageName: 'Contacts',
				packageKodyId: 'contacts',
				scheduleSummary: 'Every day',
				scheduleType: 'cron',
				timezone: 'UTC',
				enabled: true,
				killSwitchEnabled: false,
				expiresAt: null,
				expired: false,
				dueNow: false,
				lastRunStatus: null,
				nextRunAt: '2026-10-22T10:00:00Z',
				lastRunAt: null,
				runCount: 0,
				successCount: 0,
				errorCount: 0,
			},
		],
	}
	const html = await renderStartPage(createElement(WorkspaceOverview, { data }))
	expect(html).toContain('Sync contacts')
	expect(html).toContain('selected=run-1')
	expect(html).toContain('href="/@jane/-/jobs?selected=job-1"')
	expect(html).toContain('view=errors&amp;status=error&amp;triage=open')
	expect(html).toContain('>42</strong>')
	expect(html).not.toContain('No executions')
})
