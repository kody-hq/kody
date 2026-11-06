import { expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	repositories: vi.fn(),
	credentials: vi.fn(),
	jobs: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let parse = (value: unknown) => value
		const builder = {
			validator(schema: { parse: (value: unknown) => unknown }) {
				parse = schema.parse.bind(schema)
				return builder
			},
			handler(run: (input: { data: unknown }) => Promise<unknown>) {
				return (input: { data: unknown }) => run({ data: parse(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('./org-management.ts', () => ({
	loadOrgRepositories: state.repositories,
}))
vi.mock('./credentials.ts', () => ({ loadCredentialsPage: state.credentials }))
vi.mock('./account-collections.ts', () => ({ loadJobsPage: state.jobs }))
import { searchCommands } from './command-search.ts'

test('repository search preserves visibility decisions and the authenticated workspace', async () => {
	state.repositories.mockResolvedValue({
		profile: { username: 'team' },
		packages: [
			{
				name: 'Visible',
				kodyId: 'visible',
				description: 'A package',
				tags: [],
				canOpenDetail: true,
			},
			{
				name: 'Hidden',
				kodyId: 'hidden',
				description: '',
				tags: [],
				canOpenDetail: false,
			},
		],
	})
	const results = await searchCommands({
		data: { orgSlug: 'team', kind: 'repository', query: '' },
	})
	expect(state.repositories).toHaveBeenLastCalledWith({
		data: { slug: 'team', query: '' },
	})
	expect(results.map((item) => item.title)).toEqual(['Visible'])
	expect(results[0]?.href).toBe('/@team/visible')
})
test('credential search returns metadata only and propagates permission failures', async () => {
	state.credentials.mockResolvedValue({
		payload: {
			credentials: [
				{
					id: 'key-1',
					name: 'API_KEY',
					kind: 'secret',
					provider: 'example',
					status: 'ok',
					value: 'never-return-this',
					hosts: ['private.example'],
					description: 'private description',
				},
			],
		},
	})
	const results = await searchCommands({
		data: { orgSlug: 'team', kind: 'credential', query: 'api' },
	})
	expect(results[0]?.title).toBe('API_KEY')
	expect(JSON.stringify(results)).not.toMatch(
		/never-return-this|private.example|private description/,
	)
	state.credentials.mockRejectedValueOnce(new Error('Organization unavailable'))
	await expect(
		searchCommands({
			data: { orgSlug: 'other', kind: 'credential', query: '' },
		}),
	).rejects.toThrow('Organization unavailable')
})
test('job actions require confirmation and carry explicit scope, never an executable payload', async () => {
	state.jobs.mockResolvedValue({
		payload: {
			jobs: [
				{
					id: 'job-1',
					name: 'Backup',
					packageName: 'Archive',
					packageId: 'package-1',
					scheduleSummary: 'Daily',
					killSwitchEnabled: false,
				},
			],
		},
	})
	const results = await searchCommands({
		data: { orgSlug: 'team', kind: 'job', query: 'run backup' },
	})
	expect(results).toHaveLength(1)
	expect(results[0]).toMatchObject({
		title: 'Run Backup now',
		jobAction: { id: 'job-1', orgSlug: 'team', operation: 'run' },
	})
	expect(results[0]?.confirm).toContain('saved parameters')
	expect(results[0]).not.toHaveProperty('run')
})
