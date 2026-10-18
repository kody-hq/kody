import { expect, test } from 'vitest'
import {
	DEPLOY_WORKFLOW_CONTRACT_VERSION,
	assertCheckoutSatisfiesDeployWorkflowContract,
	assertDeployWorkflowContractDeclaredInWorkflow,
	checkDeployWorkflowContractDrift,
	expectedContractEnvName,
	parseExpectedContractFromEnv,
	parseExpectedContractFromWorkflowSource,
} from './deploy-workflow-contract.ts'

test('parseExpectedContractFromWorkflowSource reads quoted and bare integers', () => {
	expect(
		parseExpectedContractFromWorkflowSource(
			`env:\n  ${expectedContractEnvName}: '2'\n`,
		),
	).toBe(2)
	expect(
		parseExpectedContractFromWorkflowSource(
			`env:\n  ${expectedContractEnvName}: "3"\n`,
		),
	).toBe(3)
	expect(
		parseExpectedContractFromWorkflowSource(
			`env:\n  ${expectedContractEnvName}: 4\n`,
		),
	).toBe(4)
	expect(parseExpectedContractFromWorkflowSource('no contract here')).toBe(null)
	expect(
		parseExpectedContractFromWorkflowSource(
			`${expectedContractEnvName}: '0'\n`,
		),
	).toBe(null)
})

test('parseExpectedContractFromWorkflowSource uses sha_guard env and ignores comments', () => {
	const source = `
jobs:
  sha-guard:
    steps:
      - name: Guard
        id: sha_guard
        env:
          # ${expectedContractEnvName}: '99'
          EVENT_NAME: workflow_run
          ${expectedContractEnvName}: '2'
        run: node tools/ci/deploy-workflow-contract.ts
`
	expect(parseExpectedContractFromWorkflowSource(source)).toBe(2)

	const staleCommentBeforeActive = `
# ${expectedContractEnvName}: '1'
jobs:
  sha-guard:
    steps:
      - id: sha_guard
        env:
          ${expectedContractEnvName}: '3'
        run: echo ok
`
	expect(
		parseExpectedContractFromWorkflowSource(staleCommentBeforeActive),
	).toBe(3)
})

test('parseExpectedContractFromEnv accepts only positive integers', () => {
	expect(parseExpectedContractFromEnv('1')).toBe(1)
	expect(parseExpectedContractFromEnv(' 12 ')).toBe(12)
	expect(parseExpectedContractFromEnv('0')).toBe(null)
	expect(parseExpectedContractFromEnv('')).toBe(null)
	expect(parseExpectedContractFromEnv(undefined)).toBe(null)
	expect(parseExpectedContractFromEnv('1.5')).toBe(null)
})

test('checkout that meets or exceeds the required contract deploys', () => {
	expect(
		assertCheckoutSatisfiesDeployWorkflowContract({
			checkoutVersion: 1,
			expectedVersion: 1,
		}),
	).toEqual({ ok: true, checkoutVersion: 1, expectedVersion: 1 })
	expect(
		assertCheckoutSatisfiesDeployWorkflowContract({
			checkoutVersion: 3,
			expectedVersion: 2,
		}),
	).toEqual({ ok: true, checkoutVersion: 3, expectedVersion: 2 })
})

test('missing or older checkout contract fails with a plain redeploy message', () => {
	const missing = assertCheckoutSatisfiesDeployWorkflowContract({
		checkoutVersion: null,
		expectedVersion: 1,
	})
	expect(missing.ok).toBe(false)
	if (missing.ok) throw new Error('expected failure')
	expect(missing.missing).toBe('deploy-workflow-contract')
	expect(missing.message).toBe(
		'This commit predates the current deploy workflow (missing deploy-workflow-contract). Redeploy from main or a newer commit.',
	)

	const older = assertCheckoutSatisfiesDeployWorkflowContract({
		checkoutVersion: 1,
		expectedVersion: 2,
	})
	expect(older.ok).toBe(false)
	if (older.ok) throw new Error('expected failure')
	expect(older.missing).toBe('deploy-workflow-contract v2')
	expect(older.message).toBe(
		'This commit predates the current deploy workflow (missing deploy-workflow-contract v2; checkout has v1). Redeploy from main or a newer commit.',
	)
})

test('workflow declaration must match the module constant', () => {
	const matched = assertDeployWorkflowContractDeclaredInWorkflow({
		workflowSource: `${expectedContractEnvName}: '${String(DEPLOY_WORKFLOW_CONTRACT_VERSION)}'\n`,
		currentVersion: DEPLOY_WORKFLOW_CONTRACT_VERSION,
	})
	expect(matched).toEqual({
		ok: true,
		version: DEPLOY_WORKFLOW_CONTRACT_VERSION,
	})

	const drifted = assertDeployWorkflowContractDeclaredInWorkflow({
		workflowSource: `${expectedContractEnvName}: '99'\n`,
		currentVersion: DEPLOY_WORKFLOW_CONTRACT_VERSION,
	})
	expect(drifted.ok).toBe(false)
	if (drifted.ok) throw new Error('expected failure')
	expect(drifted.message).toContain('Bump both in the same commit')

	const absent = assertDeployWorkflowContractDeclaredInWorkflow({
		workflowSource: 'name: Deploy\n',
		currentVersion: 1,
	})
	expect(absent.ok).toBe(false)
})

test('repo deploy.yml declares the current contract (dry-run)', async () => {
	await expect(checkDeployWorkflowContractDrift()).resolves.toEqual({
		ok: true,
		version: DEPLOY_WORKFLOW_CONTRACT_VERSION,
	})
})
