import { expect, test } from 'vitest'
import {
	reportStartupBundleOverages,
	shouldReportStartupBundleOverageIssue,
	startupBundleOverageIssueMarker,
	startupBundleOverageIssueTitle,
	upsertStartupBundleOverageIssue,
} from './startup-bundle-overage-issue.ts'

test('issue reporting is limited to main CI pushes with a token', () => {
	expect(
		shouldReportStartupBundleOverageIssue({
			CI: '1',
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/heads/main',
			GH_TOKEN: 'token',
		}),
	).toBe(true)
	expect(
		shouldReportStartupBundleOverageIssue({
			CI: '1',
			GITHUB_EVENT_NAME: 'pull_request',
			GITHUB_REF: 'refs/heads/main',
			GH_TOKEN: 'token',
		}),
	).toBe(false)
	expect(
		shouldReportStartupBundleOverageIssue({
			CI: '1',
			GITHUB_EVENT_NAME: 'push',
			GITHUB_REF: 'refs/heads/main',
		}),
	).toBe(false)
})

test('upsertStartupBundleOverageIssue creates once then updates', () => {
	const calls: Array<Array<string>> = []
	let existing: { number: number; title: string; body: string } | null = null
	const gh = (args: Array<string>) => {
		calls.push(args)
		if (args[0] === 'issue' && args[1] === 'create') {
			existing = {
				number: 42,
				title: startupBundleOverageIssueTitle('runtime'),
				body: 'created',
			}
			return 'https://github.com/kody-hq/kody/issues/42\n'
		}
		return ''
	}
	const findOpen = () => existing
	const overage = {
		name: 'runtime' as const,
		size: 3_912_588,
		maxEntryBytes: 3_912_500,
		overage: 88,
	}
	const env = {
		CI: '1',
		GITHUB_EVENT_NAME: 'push',
		GITHUB_REF: 'refs/heads/main',
		GH_TOKEN: 'token',
	}
	expect(
		upsertStartupBundleOverageIssue(overage, { env, gh, findOpen }),
	).toEqual({
		action: 'created',
		name: 'runtime',
		url: 'https://github.com/kody-hq/kody/issues/42',
	})
	expect(
		upsertStartupBundleOverageIssue(overage, { env, gh, findOpen }),
	).toEqual({
		action: 'updated',
		name: 'runtime',
		number: 42,
	})
	expect(calls.some((args) => args[1] === 'create')).toBe(true)
	expect(calls.some((args) => args[1] === 'edit')).toBe(true)
	expect(calls.some((args) => args[1] === 'comment')).toBe(true)
})

function reportingEnv() {
	return {
		CI: '1',
		GITHUB_EVENT_NAME: 'push',
		GITHUB_REF: 'refs/heads/main',
		GH_TOKEN: 'token',
	}
}

function listSearchQuery(args: Array<string>) {
	const index = args.indexOf('--search')
	return index === -1 ? null : (args[index + 1] ?? null)
}

test('canonical title search updates the open issue without a labeled-list scan', () => {
	const calls: Array<Array<string>> = []
	const titled = {
		number: 42,
		title: startupBundleOverageIssueTitle('runtime'),
		body: 'earlier measure',
	}
	const gh = (args: Array<string>) => {
		calls.push(args)
		if (args[0] === 'issue' && args[1] === 'list') {
			return JSON.stringify([titled])
		}
		return ''
	}
	expect(
		upsertStartupBundleOverageIssue(
			{
				name: 'runtime',
				size: 3_912_588,
				maxEntryBytes: 3_912_500,
				overage: 88,
			},
			{
				env: reportingEnv(),
				gh,
			},
		),
	).toEqual({
		action: 'updated',
		name: 'runtime',
		number: 42,
	})
	expect(listSearchQuery(calls[0] ?? [])).toBe(
		'"Startup budget overage: runtime" in:title',
	)
	expect(calls.filter((args) => args[1] === 'list')).toHaveLength(1)
	expect(calls.some((args) => args.includes('--label'))).toBe(false)
	expect(calls.some((args) => args[1] === 'create')).toBe(false)
})

test('renamed open tracking issue is found by local marker match, not GitHub comment search', () => {
	const calls: Array<Array<string>> = []
	const marker = startupBundleOverageIssueMarker('runtime')
	const renamed = {
		number: 77,
		title: 'Startup growth to investigate (runtime)',
		body: `${marker}\nMeasured earlier.`,
	}
	const gh = (args: Array<string>) => {
		calls.push(args)
		if (args[0] === 'issue' && args[1] === 'list') {
			if (listSearchQuery(args) !== null) {
				return JSON.stringify([])
			}
			return JSON.stringify([renamed])
		}
		return ''
	}
	const result = upsertStartupBundleOverageIssue(
		{
			name: 'runtime',
			size: 3_912_588,
			maxEntryBytes: 3_912_500,
			overage: 88,
		},
		{
			env: reportingEnv(),
			gh,
		},
	)
	expect(result).toEqual({
		action: 'updated',
		name: 'runtime',
		number: 77,
	})
	const titleSearch = calls.find((args) => listSearchQuery(args) !== null)
	const labeledList = calls.find(
		(args) => args[1] === 'list' && args.includes('--label'),
	)
	expect(listSearchQuery(titleSearch ?? [])).toBe(
		'"Startup budget overage: runtime" in:title',
	)
	expect(labeledList).toContain('--label')
	expect(labeledList).toContain('friction')
	expect(calls.some((args) => args[1] === 'create')).toBe(false)
	expect(calls.some((args) => args[1] === 'edit' && args[2] === '77')).toBe(
		true,
	)
})

test('rejected title search still creates when no labeled issue exists', () => {
	const calls: Array<Array<string>> = []
	const gh = (args: Array<string>) => {
		calls.push(args)
		if (args[0] === 'issue' && args[1] === 'list') {
			if (listSearchQuery(args) !== null) {
				throw new Error('Invalid search query')
			}
			return JSON.stringify([])
		}
		if (args[0] === 'issue' && args[1] === 'create') {
			return 'https://github.com/kody-hq/kody/issues/99\n'
		}
		return ''
	}
	expect(
		upsertStartupBundleOverageIssue(
			{
				name: 'runtime',
				size: 3_912_588,
				maxEntryBytes: 3_912_500,
				overage: 88,
			},
			{
				env: reportingEnv(),
				gh,
			},
		),
	).toEqual({
		action: 'created',
		name: 'runtime',
		url: 'https://github.com/kody-hq/kody/issues/99',
	})
	expect(calls.some((args) => args[1] === 'create')).toBe(true)
})

test('reportStartupBundleOverages never throws when upsert fails', () => {
	const logs: Array<string> = []
	const actions = reportStartupBundleOverages(
		[
			{
				name: 'runtime',
				size: 3_912_588,
				maxEntryBytes: 3_912_500,
				overage: 88,
			},
		],
		{
			env: {
				CI: '1',
				GITHUB_EVENT_NAME: 'push',
				GITHUB_REF: 'refs/heads/main',
				GH_TOKEN: 'token',
			},
			upsert: () => {
				throw new Error('gh unavailable')
			},
			log: (message) => logs.push(message),
		},
	)
	expect(actions).toEqual([
		{
			action: 'skipped',
			name: 'runtime',
			reason: 'gh unavailable',
		},
	])
	expect(logs.join('\n')).toMatch(/does not fail CI/)
	expect(logs.join('\n')).toMatch(/Failed to upsert/)
})
