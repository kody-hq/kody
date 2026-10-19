import { expect, test } from 'vitest'
import {
	buildHealthReport,
	encodeDeployInfo,
	parseDeployInfo,
	prefersHtml,
	pullRequestNumberFromCommitMessage,
	truncateCommitMessage,
	type DeployInfo,
} from './deploy-info.ts'

const sampleDeployInfo = {
	repoUrl: 'https://github.com/kody-hq/kody',
	commit: {
		sha: 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e',
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
		environment: 'production',
		workflow: '🚀 Deploy (production)',
		job: 'deploy',
		runId: '12345',
		runUrl: 'https://github.com/kody-hq/kody/actions/runs/12345',
	},
} satisfies DeployInfo

const sha = 'f2d82dba4ba50cf2ad3f56f5c88f7b8ef5f97d8e'

function healthReport(
	commitSha: string | null,
	commit: { message: string; committedAt: string } | null = null,
	deployInfo: Pick<DeployInfo, 'pullRequest' | 'deploy'> | null = null,
) {
	return {
		ok: true,
		commitSha,
		commit: commitSha
			? {
					sha: commitSha,
					url: `https://github.com/kody-hq/kody/commit/${commitSha}`,
					message: commit?.message ?? null,
					committedAt: commit?.committedAt ?? null,
				}
			: null,
		pullRequest: deployInfo?.pullRequest ?? null,
		deploy: deployInfo?.deploy ?? null,
	}
}

test('deploy info encodes for wrangler vars and rebuilds the /health report', () => {
	expect(
		[undefined, 'not-valid', '{'].map((value) => parseDeployInfo(value)),
	).toEqual([null, null, null])
	expect(parseDeployInfo(JSON.stringify(sampleDeployInfo))).toEqual(
		sampleDeployInfo,
	)
	expect(parseDeployInfo(encodeDeployInfo(sampleDeployInfo))).toEqual(
		sampleDeployInfo,
	)

	const otherSha = 'a'.repeat(40)
	const encoded = encodeDeployInfo(sampleDeployInfo)
	expect([
		buildHealthReport({}),
		buildHealthReport({ APP_COMMIT_SHA: sha }),
		buildHealthReport({ APP_COMMIT_SHA: sha, APP_DEPLOY_INFO: encoded }),
		buildHealthReport({ APP_COMMIT_SHA: otherSha, APP_DEPLOY_INFO: encoded }),
	]).toEqual([
		healthReport(null),
		healthReport(sha),
		healthReport(sha, sampleDeployInfo.commit, sampleDeployInfo),
		healthReport(otherSha),
	])
	expect(
		buildHealthReport({ APP_COMMIT_SHA: sha, APP_DEPLOY_INFO: '%%%' })
			.commitSha,
	).toBe(sha)

	expect(pullRequestNumberFromCommitMessage('feat: foo (#12)\n\n(#99)')).toBe(
		99,
	)
	expect(pullRequestNumberFromCommitMessage('no pr here')).toBeNull()
	expect(truncateCommitMessage(`${'a'.repeat(500)}extra`).length).toBe(500)
	const prefersHtmlCases: Array<[string | null, boolean]> = [
		[null, false],
		['*/*', false],
		['application/json', false],
		['application/json, text/plain, */*', false],
		['text/html,application/xhtml+xml', true],
		['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', true],
		['application/json, text/html', false],
	]
	expect(
		prefersHtmlCases.filter(([accept, want]) => prefersHtml(accept) !== want),
	).toEqual([])
})
