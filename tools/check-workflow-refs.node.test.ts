import { expect, test } from 'vitest'
import { checkWorkflowSource } from './check-workflow-refs.ts'

const validWorkflow = `
name: Deploy
on:
  push:
    branches:
      - main
jobs:
  sha-guard:
    outputs:
      deploy_sha: \${{ steps.sha_guard.outputs.deploy_sha }}
    steps:
      - name: Guard
        id: sha_guard
        run: echo deploy_sha=abc >> "$GITHUB_OUTPUT"
  deploy:
    needs: sha-guard
    if: needs.sha-guard.outputs.deploy_sha != ''
    steps:
      - name: Config
        id: runtime_config
        run: echo runtime_wrangler_config=x >> "$GITHUB_OUTPUT"
      - name: Upload
        env:
          CONFIG: \${{ steps.runtime_config.outputs.runtime_wrangler_config }}
        run: echo "$CONFIG"
`

test('accepts step and job ids that exist in the same workflow', () => {
	expect(checkWorkflowSource('deploy.yml', validWorkflow)).toEqual([])
})

test('rejects a misspelled steps.<id>.outputs reference', () => {
	const source = validWorkflow.replace(
		'steps.runtime_config.outputs.runtime_wrangler_config',
		'steps.runtime_cfg.outputs.runtime_wrangler_config',
	)
	expect(checkWorkflowSource('deploy.yml', source)).toEqual([
		{
			file: 'deploy.yml',
			line: 24,
			message:
				'steps.runtime_cfg.outputs references a step id that does not exist in job "deploy".',
		},
	])
})

test('rejects a misspelled needs.<id> reference and an unknown needs list item', () => {
	const source = `
jobs:
  first:
    steps:
      - id: one
        run: echo hi
  second:
    needs:
      - missing-job
    if: needs.first.outputs.ok == 'true' && needs.missing.outputs.ok == 'true'
    steps:
      - run: echo hi
`
	expect(checkWorkflowSource('deploy.yml', source)).toEqual([
		{
			file: 'deploy.yml',
			line: 10,
			message: 'needs.first is not declared in job "second" needs.',
		},
		{
			file: 'deploy.yml',
			line: 10,
			message:
				'needs.missing references a job id that does not exist in this workflow.',
		},
		{
			file: 'deploy.yml',
			line: 9,
			message:
				'needs: missing-job references a job id that does not exist in this workflow.',
		},
	])
})

test('rejects a flow-list needs typo and an undeclared needs context', () => {
	const source = `
jobs:
  sha-guard:
    steps:
      - run: echo hi
  deploy:
    needs: [sha-guard, typo]
    if: needs.sha-guard.outputs.ok == 'true'
    steps:
      - run: echo hi
  other:
    if: needs.sha-guard.outputs.ok == 'true'
    steps:
      - run: echo hi
`
	expect(checkWorkflowSource('deploy.yml', source)).toEqual([
		{
			file: 'deploy.yml',
			line: 7,
			message:
				'needs: typo references a job id that does not exist in this workflow.',
		},
		{
			file: 'deploy.yml',
			line: 12,
			message: 'needs.sha-guard is not declared in job "other" needs.',
		},
	])
})

test('does not treat a with: id as a step id', () => {
	const source = `
jobs:
  deploy:
    steps:
      - name: Config
        id: runtime_config
        run: echo hi
      - name: Action
        uses: actions/example@v1
        with:
          id: runtime_config
      - run: echo \${{ steps.ghost.outputs.unused }}
`
	expect(checkWorkflowSource('deploy.yml', source)).toEqual([
		{
			file: 'deploy.yml',
			line: 12,
			message:
				'steps.ghost.outputs references a step id that does not exist in job "deploy".',
		},
	])
})

test('ignores commented-out references and does not leak step ids across jobs', () => {
	const source = `
jobs:
  one:
    steps:
      - id: runtime_config
        run: echo hi
  two:
    steps:
      - run: echo \${{ steps.runtime_config.outputs.runtime_wrangler_config }}
      # - run: echo \${{ steps.ghost.outputs.unused }}
`
	expect(checkWorkflowSource('deploy.yml', source)).toEqual([
		{
			file: 'deploy.yml',
			line: 9,
			message:
				'steps.runtime_config.outputs references a step id that does not exist in job "two".',
		},
	])
})
