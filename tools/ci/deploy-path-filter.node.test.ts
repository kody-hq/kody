import { expect, test } from 'vitest'
import { classifyProductionDeployPaths } from './deploy-path-filter.ts'

type Script =
	| 'main'
	| 'platform'
	| 'runtime'
	| 'jobs'
	| 'highlight'
	| 'push-queue'

function deploys(...scripts: Array<Script>) {
	return {
		deployMain: scripts.includes('main'),
		deployPlatform: scripts.includes('platform'),
		deployRuntime: scripts.includes('runtime'),
		deployJobs: scripts.includes('jobs'),
		deployHighlight: scripts.includes('highlight'),
		deployPushQueue: scripts.includes('push-queue'),
	}
}

test('production deploy path filter selects worker scripts only when their sources change', () => {
	const originWorkers = deploys('main', 'platform', 'runtime')
	const cases: Array<[Array<string>, ReturnType<typeof deploys>]> = [
		[
			[
				'packages/worker/src/blog/posts/your-assistants-home.md',
				'packages/worker/start/routes/blog.tsx',
				'packages/worker/public/styles.css',
			],
			deploys('main'),
		],
		[['packages/worker/start/server/account.ts'], deploys('main')],
		[['docs/guides/what-is-kody.md'], deploys('main', 'platform')],
		[
			[
				'docs/guides/what-is-kody.md',
				'packages/worker/src/blog/posts/your-assistants-home.md',
				'packages/worker/start/routes/blog.tsx',
			],
			deploys('main', 'platform'),
		],
		[['packages/worker/src/guides/catalog.ts'], deploys('main', 'platform')],
		[['packages/worker/src/app/handlers/package-app.ts'], originWorkers],
		[['packages/worker/src/app/handlers/home.ts'], deploys('main')],
		[['packages/highlight-worker/src/index.ts'], deploys('highlight')],
		[
			[
				'packages/highlight-worker/src/index.ts',
				'packages/worker/start/pages/blog-post.tsx',
			],
			deploys('main', 'highlight'),
		],
		[
			[],
			deploys('main', 'platform', 'runtime', 'jobs', 'highlight', 'push-queue'),
		],
		[
			['packages/push-queue-worker/src/repo-push-queue.ts'],
			deploys('push-queue'),
		],
		[
			['packages/shared/src/artifacts-receive-pack-wait.ts'],
			deploys('main', 'push-queue'),
		],
		[
			['packages/shared/src/repo-push-queue-protocol.ts'],
			deploys('main', 'push-queue'),
		],
		// MCP + fetch-gateway run on platform and runtime; do not skip those
		// scripts the way a UI-only origin path would.
		[
			['docs/guides/what-is-kody.md', 'packages/worker/src/mcp/index.ts'],
			originWorkers,
		],
		[
			[
				'docs/use/secrets-and-values.md',
				'packages/worker/src/mcp/fetch-gateway.ts',
				'packages/worker/src/mcp/fetch-gateway.node.test.ts',
			],
			originWorkers,
		],
		[
			[
				'packages/worker/src/app/canonical-host.ts',
				'packages/worker/src/app/package-app-origin.ts',
			],
			originWorkers,
		],
		// Runtime-token wiring in deploy.yml must not upload jobs/highlight.
		[['.github/workflows/deploy.yml'], originWorkers],
		[
			[
				'.github/workflows/deploy.yml',
				'docs/contributing/environment-variables.md',
				'docs/contributing/setup-manifest.md',
				'tools/ci/sync-worker-secrets.node.test.ts',
				'tools/ci/sync-worker-secrets.ts',
			],
			originWorkers,
		],
		[
			[
				'packages/backup-control-plane/worker.ts',
				'tools/disaster-recovery/readiness-assessment.ts',
				'docs/contributing/disaster-recovery.md',
			],
			deploys(),
		],
		[
			[
				'packages/backup-control-plane/worker.ts',
				'packages/shared/src/backup-full-manifest.ts',
				'tools/disaster-recovery/readiness-assessment.ts',
				'docs/contributing/disaster-recovery.md',
			],
			deploys('main'),
		],
		[
			[
				'packages/worker/src/origin-handler.ts',
				'packages/worker/src/platform-worker.ts',
				'packages/worker/src/runtime-worker.ts',
				'packages/worker/src/app/canonical-host.ts',
				'docs/contributing/architecture/request-lifecycle.md',
			],
			originWorkers,
		],
		[['packages/jobs-worker/src/index.ts'], deploys('jobs')],
		[
			[
				'packages/jobs-worker/src/index.ts',
				'packages/worker/src/app/handlers/home.ts',
			],
			deploys('main', 'jobs'),
		],
		[['packages/shared/src/jobs/rpc.ts'], deploys('main', 'jobs')],
		[
			['packages/shared/src/d1-retry.ts'],
			deploys('main', 'platform', 'runtime', 'jobs'),
		],
		[
			['packages/shared/src/chat.ts'],
			deploys('main', 'platform', 'runtime', 'jobs'),
		],
		[
			['packages/worker/universal/highlighted-code.ts'],
			deploys('main', 'highlight'),
		],
		[['tools/ci/deploy-path-filter.ts'], originWorkers],
		[['packages/api-worker/src/index.ts'], deploys()],
		[['packages/api-docs-worker/src/index.ts'], deploys()],
		[
			[
				'packages/api-worker/src/index.ts',
				'packages/worker/src/open-api/http-handler.ts',
			],
			originWorkers,
		],
	]
	expect(
		cases.map(([paths]) => [paths, classifyProductionDeployPaths(paths)]),
	).toEqual(cases)
})
