import { expect, test } from 'vitest'
import { encodeDeployInfo, type DeployInfo } from '#worker/deploy-info.ts'
import { createHealthHandler } from '#app/handlers/health.ts'

const commitSha = 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e'
const deployInfo = {
	repoUrl: 'https://github.com/kody-hq/kody',
	commit: {
		sha: commitSha,
		message: 'feat: richer /health metadata (#1799)',
		committedAt: '2026-08-27T18:00:00Z',
	},
	pullRequest: {
		number: 1799,
		url: 'https://github.com/kody-hq/kody/pull/1799',
		title: 'Richer /health metadata',
	},
	deploy: {
		deployedAt: '2026-08-27T18:05:00Z',
		environment: 'preview',
		workflow: '🔎 Preview',
		job: 'deploy',
		runId: '99',
		runUrl: 'https://github.com/kody-hq/kody/actions/runs/99',
	},
} satisfies DeployInfo

function createHealthRequestContext(accept?: string) {
	return {
		request: new Request('https://example.com/health', {
			headers: accept ? { Accept: accept } : undefined,
		}),
	}
}

test('health handler reports commit, PR, and deploy metadata for JSON and HTML clients', async () => {
	const unsetHandler = createHealthHandler({
		APP_COMMIT_SHA: undefined,
		APP_DEPLOY_INFO: undefined,
	})
	const unsetResponse = await unsetHandler(createHealthRequestContext())
	expect(unsetResponse.status).toBe(200)
	expect(unsetResponse.headers.get('Cache-Control')).toBe('no-store')
	expect(unsetResponse.headers.get('X-App-Commit-Sha')).toBe('unknown')
	expect(await unsetResponse.json()).toEqual({
		ok: true,
		commitSha: null,
		commit: null,
		pullRequest: null,
		deploy: null,
	})

	const shaOnlyHandler = createHealthHandler({
		APP_COMMIT_SHA: commitSha,
		APP_DEPLOY_INFO: undefined,
	})
	const shaOnlyResponse = await shaOnlyHandler(
		createHealthRequestContext('application/json'),
	)
	expect(shaOnlyResponse.headers.get('X-App-Commit-Sha')).toBe(commitSha)
	expect(await shaOnlyResponse.json()).toEqual({
		ok: true,
		commitSha,
		commit: {
			sha: commitSha,
			url: `https://github.com/kody-hq/kody/commit/${commitSha}`,
			message: null,
			committedAt: null,
		},
		pullRequest: null,
		deploy: null,
	})

	const deployedHandler = createHealthHandler({
		APP_COMMIT_SHA: commitSha,
		APP_DEPLOY_INFO: encodeDeployInfo(deployInfo),
	})
	const jsonResponse = await deployedHandler(createHealthRequestContext())
	expect(await jsonResponse.json()).toEqual({
		ok: true,
		commitSha,
		commit: {
			sha: commitSha,
			url: `https://github.com/kody-hq/kody/commit/${commitSha}`,
			message: deployInfo.commit.message,
			committedAt: deployInfo.commit.committedAt,
		},
		pullRequest: deployInfo.pullRequest,
		deploy: deployInfo.deploy,
	})

	const htmlResponse = await deployedHandler(
		createHealthRequestContext('text/html'),
	)
	expect(htmlResponse.headers.get('Content-Type')).toBe(
		'text/html; charset=utf-8',
	)
	const html = await htmlResponse.text()
	expect(html).toContain(commitSha)
	expect(html).toContain(`https://github.com/kody-hq/kody/commit/${commitSha}`)
	expect(html).toContain(deployInfo.pullRequest.url)
	expect(html).toContain(deployInfo.deploy.runUrl)
	expect(html).toContain(deployInfo.commit.message)
})
