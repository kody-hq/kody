import { expect, test } from 'vitest'
import {
	githubTokenFromEnv,
	parseGithubRepository,
	scanOpenPullRequestFiles,
	scanOpenPullRequestMigrationPrefixes,
} from './open-pull-request-migration-prefixes.ts'

const migrationsDir = 'packages/worker/migrations'
const token = 'super-secret-token'

test('github repository and token parsing stay free of credential material', () => {
	expect(githubTokenFromEnv({ GH_TOKEN: ' gh ', GITHUB_TOKEN: 'other' })).toBe(
		'gh',
	)
	expect(githubTokenFromEnv({ GITHUB_TOKEN: 'actions' })).toBe('actions')
	expect(githubTokenFromEnv({ GH_TOKEN: ' ', GITHUB_TOKEN: '' })).toBeNull()

	const secretUrl = 'https://x-access-token:secret@github.com/kody-hq/kody.git'
	expect(parseGithubRepository(secretUrl)).toBe('kody-hq/kody')
	expect(parseGithubRepository('git@github.com:kody-hq/kody.git')).toBe(
		'kody-hq/kody',
	)
	expect(parseGithubRepository('kody-hq/kody')).toBe('kody-hq/kody')
	expect(parseGithubRepository('https://gitlab.com/kody-hq/kody')).toBeNull()
	expect(
		parseGithubRepository('https://github.com/kody-hq/kody/pull/1'),
	).toBeNull()
	expect(
		parseGithubRepository(
			'https://git-manager.devin.ai/proxy/github.com/kody-hq/kody',
		),
	).toBe('kody-hq/kody')
	expect(
		parseGithubRepository(
			'https://git-manager.devin.ai/proxy/github.com/kody-hq/kody.git',
		),
	).toBe('kody-hq/kody')
	expect(
		parseGithubRepository(
			'https://git-manager.devin.ai/proxy/github.com/kody-hq/kody/pull/1',
		),
	).toBeNull()
	expect(parseGithubRepository(secretUrl)).not.toContain('secret')
})

test('open pull request migration files are listed and the current pull request is skipped', async () => {
	const calls: Array<{ url: string; authorization: string }> = []
	const scan = await scanOpenPullRequestMigrationPrefixes({
		migrationsDir,
		repository: 'kody-hq/kody',
		token,
		baseRef: 'main',
		env: { GITHUB_REF: 'refs/pull/7/merge' },
		fetchImpl: (input, init) => {
			const url = input instanceof URL ? input : new URL(String(input))
			const headers = init?.headers as Record<string, string>
			calls.push({ url: url.href, authorization: headers.Authorization ?? '' })
			const page = url.searchParams.get('page')
			if (url.pathname.endsWith('/pulls')) {
				expect(url.searchParams.get('state')).toBe('open')
				expect(url.searchParams.get('base')).toBe('main')
				expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
				return Promise.resolve(
					Response.json([{ number: 7 }, { number: 8 }, { number: 9 }]),
				)
			}
			expect(page).toBe('1')
			if (url.pathname.endsWith('/pulls/8/files')) {
				return Promise.resolve(
					Response.json([
						{
							filename: `${migrationsDir}/0098-usage.sql`,
							status: 'added',
						},
						{
							filename: `${migrationsDir}/0096-old.sql`,
							status: 'removed',
						},
						{
							filename: 'docs/contributing/setup/migrations.md',
							status: 'modified',
						},
						{
							filename: `${migrationsDir}/nested/0099-hidden.sql`,
							status: 'added',
						},
						{
							filename: 'packages/jobs-worker/migrations/0004-jobs.sql',
							status: 'added',
						},
					]),
				)
			}
			if (url.pathname.endsWith('/pulls/9/files')) {
				return Promise.resolve(
					Response.json([
						{
							filename: `${migrationsDir}/0097-contract.sql`,
							status: 'renamed',
						},
					]),
				)
			}
			return Promise.resolve(Response.json([]))
		},
	})

	expect(scan).toEqual({
		status: 'ok',
		claims: [
			{
				number: 8,
				filenames: [`${migrationsDir}/0098-usage.sql`],
			},
			{
				number: 9,
				filenames: [`${migrationsDir}/0097-contract.sql`],
			},
		],
	})
	expect(calls.some((call) => call.url.includes('/pulls/7/files'))).toBe(false)
	expect(calls.every((call) => call.authorization === `Bearer ${token}`)).toBe(
		true,
	)
	expect(calls.some((call) => call.url.includes(token))).toBe(false)
})

test('the generic file scan applies its own directory and claim filter', async () => {
	const decisionsDir = 'docs/contributing/decisions'
	const scan = await scanOpenPullRequestFiles({
		directory: decisionsDir,
		claimsFile: (file) =>
			file.status !== 'removed' && /^\d{4}-.+\.md$/.test(file.basename),
		repository: 'kody-hq/kody',
		token,
		baseRef: 'main',
		currentPullNumber: 3,
		fetchImpl: (input) => {
			const url = input instanceof URL ? input : new URL(String(input))
			if (url.pathname.endsWith('/pulls')) {
				return Promise.resolve(Response.json([{ number: 3 }, { number: 4 }]))
			}
			if (url.pathname.endsWith('/pulls/4/files')) {
				return Promise.resolve(
					Response.json([
						{ filename: `${decisionsDir}/0096-new.md`, status: 'added' },
						{ filename: `${decisionsDir}/0090-gone.md`, status: 'removed' },
						{ filename: `${decisionsDir}/index.md`, status: 'modified' },
						{ filename: `${migrationsDir}/0098-usage.sql`, status: 'added' },
					]),
				)
			}
			throw new Error(`unexpected request ${url.pathname}`)
		},
	})
	expect(scan).toEqual({
		status: 'ok',
		claims: [{ number: 4, filenames: [`${decisionsDir}/0096-new.md`] }],
	})
})

test('pull and file lists page until a short page', async () => {
	const requested: Array<string> = []
	const noise = Array.from({ length: 100 }, (_, index) => ({
		filename: `docs/file-${String(index)}.md`,
		status: 'modified',
	}))
	const scan = await scanOpenPullRequestMigrationPrefixes({
		migrationsDir,
		repository: 'kody-hq/kody',
		token,
		currentPullNumber: null,
		fetchImpl: (input) => {
			const url = input instanceof URL ? input : new URL(String(input))
			requested.push(`${url.pathname}?${url.searchParams.toString()}`)
			const page = Number(url.searchParams.get('page'))
			if (url.pathname.endsWith('/pulls')) {
				const pulls =
					page === 1
						? Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }))
						: [{ number: 101 }]
				return Promise.resolve(Response.json(pulls))
			}
			const files = url.pathname.endsWith('/pulls/101/files')
				? page === 1
					? noise
					: [
							{
								filename: `${migrationsDir}/0101-from-second-page.sql`,
								status: 'added',
							},
						]
				: []
			return Promise.resolve(Response.json(files))
		},
	})
	expect(scan).toEqual({
		status: 'ok',
		claims: [
			{
				number: 101,
				filenames: [`${migrationsDir}/0101-from-second-page.sql`],
			},
		],
	})
	expect(
		requested.some((url) => url.includes('/pulls?') && url.includes('page=2')),
	).toBe(true)
	expect(
		requested.some(
			(url) => url.includes('/pulls/101/files') && url.includes('page=2'),
		),
	).toBe(true)
})

test('missing auth, a bad repository, and GitHub failures skip without throwing', async () => {
	let fetches = 0
	const fetchImpl: typeof fetch = () => {
		fetches += 1
		return Promise.resolve(Response.json([]))
	}
	expect(
		await scanOpenPullRequestMigrationPrefixes({
			migrationsDir,
			repository: null,
			token,
			fetchImpl,
		}),
	).toEqual({ status: 'skipped', reason: 'no-repository' })
	expect(
		await scanOpenPullRequestMigrationPrefixes({
			migrationsDir,
			repository: 'kody-hq/kody',
			token: null,
			currentPullNumber: null,
			fetchImpl,
		}),
	).toEqual({ status: 'skipped', reason: 'no-token' })
	expect(
		await scanOpenPullRequestMigrationPrefixes({
			migrationsDir,
			repository: 'https://user:secret@github.com/kody-hq/kody',
			token,
			currentPullNumber: null,
			fetchImpl,
		}),
	).toEqual({
		status: 'skipped',
		reason: 'error',
		detail: 'Unrecognized GitHub repository.',
	})
	expect(
		await scanOpenPullRequestMigrationPrefixes({
			migrationsDir,
			repository: 'kody-hq/kody',
			token,
			baseRef: 'main;touch',
			currentPullNumber: null,
			fetchImpl,
		}),
	).toMatchObject({ status: 'skipped', reason: 'error' })
	expect(fetches).toBe(0)

	const unauthorized = await scanOpenPullRequestMigrationPrefixes({
		migrationsDir,
		repository: 'kody-hq/kody',
		token,
		currentPullNumber: null,
		fetchImpl: () =>
			Promise.resolve(
				new Response(`Bad credentials ${token}`, { status: 401 }),
			),
	})
	expect(unauthorized.status).toBe('skipped')
	if (unauthorized.status === 'skipped') {
		expect(unauthorized.reason).toBe('unauthorized')
		expect(unauthorized.detail).toContain('401')
		expect(unauthorized.detail).toContain('[redacted]')
		expect(unauthorized.detail).not.toContain(token)
	}

	const malformed = await scanOpenPullRequestMigrationPrefixes({
		migrationsDir,
		repository: 'kody-hq/kody',
		token,
		currentPullNumber: null,
		fetchImpl: () => Promise.resolve(Response.json({ unexpected: true })),
	})
	expect(malformed).toMatchObject({
		status: 'skipped',
		reason: 'error',
	})
	if (malformed.status === 'skipped') {
		expect(malformed.detail).toContain('not an array')
		expect(malformed.detail).not.toContain(token)
	}

	const timedOut = await scanOpenPullRequestMigrationPrefixes({
		migrationsDir,
		repository: 'kody-hq/kody',
		token,
		currentPullNumber: null,
		fetchImpl: () => {
			const error = new Error('aborted')
			error.name = 'TimeoutError'
			return Promise.reject(error)
		},
	})
	expect(timedOut).toMatchObject({ status: 'skipped', reason: 'error' })
	if (timedOut.status === 'skipped') {
		expect(timedOut.detail).toContain('timed out')
		expect(timedOut.detail).not.toContain(token)
	}
})
