import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const workflow = readFileSync(
	new URL('../../.github/workflows/deploy.yml', import.meta.url),
	'utf8',
)

test('deploy run name and summary show the SHA the run deploys', () => {
	const runName = /^run-name: >-\n((?: {2}.*\n)+)/m.exec(workflow)?.[1] ?? ''
	expect(runName).toContain('github.event.workflow_run.head_sha')
	expect(runName).not.toContain('github.event.workflow_run.head_commit')
	expect(workflow).toMatch(
		/echo "Deploy SHA: \\`\$DEPLOY_SHA\\`"[\s\S]*>> "\$GITHUB_STEP_SUMMARY"/,
	)
})
