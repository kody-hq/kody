/**
 * Fail-fast guard for `.github/workflows/deploy.yml`.
 *
 * GitHub loads the workflow YAML from the tip of the default branch, but the
 * job checks out the deploy SHA (which can be an older validated main commit).
 * When tip-of-main workflow steps rely on checkout-side flags or scripts that
 * an older SHA lacks, the run otherwise fails midway (for example
 * `Unknown flag: --versioned`).
 *
 * Contract:
 * - `DEPLOY_WORKFLOW_CONTRACT_VERSION` lives in this file on the checkout.
 * - `EXPECTED_DEPLOY_WORKFLOW_CONTRACT` is declared in deploy.yml (the running
 *   workflow from tip-of-main) and passed as an env var to this script.
 * - When tip-of-main workflow gains a checkout-coupled requirement, bump both
 *   values in the same commit. Compatible older commits that already carry the
 *   new version still deploy; commits that predate it fail with a plain error.
 *
 * `npm run workflows:check` rejects drift between the YAML expected value and
 * this constant so a one-sided bump cannot land on main.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from '../node-runtime.ts'

/** Bump together with EXPECTED_DEPLOY_WORKFLOW_CONTRACT in deploy.yml. */
export const DEPLOY_WORKFLOW_CONTRACT_VERSION = 1

export const expectedContractEnvName = 'EXPECTED_DEPLOY_WORKFLOW_CONTRACT'

export const deployWorkflowRelativePath = path.join(
	'.github',
	'workflows',
	'deploy.yml',
)

const versionPattern = /^[1-9][0-9]*$/

export type DeployWorkflowContractDecision =
	| { ok: true; checkoutVersion: number; expectedVersion: number }
	| {
			ok: false
			missing: string
			message: string
			checkoutVersion: number | null
			expectedVersion: number
	  }

/**
 * Parse the integer the running deploy.yml declares as its required contract.
 * Accepts `EXPECTED_DEPLOY_WORKFLOW_CONTRACT: '1'` / `"1"` / `1`.
 */
export function parseExpectedContractFromWorkflowSource(
	source: string,
): number | null {
	const match = source.match(
		new RegExp(
			`${expectedContractEnvName}:\\s*(?:'([0-9]+)'|"([0-9]+)"|([0-9]+))`,
		),
	)
	const raw = match?.[1] ?? match?.[2] ?? match?.[3]
	if (!raw || !versionPattern.test(raw)) return null
	return Number(raw)
}

export function parseExpectedContractFromEnv(
	value: string | undefined,
): number | null {
	const raw = value?.trim()
	if (!raw || !versionPattern.test(raw)) return null
	return Number(raw)
}

export function assertCheckoutSatisfiesDeployWorkflowContract(input: {
	checkoutVersion: number | null
	expectedVersion: number
}): DeployWorkflowContractDecision {
	const { checkoutVersion, expectedVersion } = input
	if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
		throw new Error(
			`${expectedContractEnvName} must be a positive integer (got ${String(expectedVersion)}).`,
		)
	}
	if (checkoutVersion === null) {
		return {
			ok: false,
			missing: 'deploy-workflow-contract',
			checkoutVersion: null,
			expectedVersion,
			message:
				'This commit predates the current deploy workflow (missing deploy-workflow-contract). Redeploy from main or a newer commit.',
		}
	}
	if (!Number.isInteger(checkoutVersion) || checkoutVersion < 1) {
		return {
			ok: false,
			missing: `deploy-workflow-contract v${String(expectedVersion)}`,
			checkoutVersion,
			expectedVersion,
			message: `This commit predates the current deploy workflow (invalid deploy-workflow-contract version ${String(checkoutVersion)}). Redeploy from main or a newer commit.`,
		}
	}
	if (checkoutVersion < expectedVersion) {
		return {
			ok: false,
			missing: `deploy-workflow-contract v${String(expectedVersion)}`,
			checkoutVersion,
			expectedVersion,
			message: `This commit predates the current deploy workflow (missing deploy-workflow-contract v${String(expectedVersion)}; checkout has v${String(checkoutVersion)}). Redeploy from main or a newer commit.`,
		}
	}
	return { ok: true, checkoutVersion, expectedVersion }
}

export type DeployWorkflowContractDrift =
	| { ok: true; version: number }
	| { ok: false; message: string }

/** Validate-time dry-run: tip workflow expected version must match this module. */
export function assertDeployWorkflowContractDeclaredInWorkflow(input: {
	workflowSource: string
	currentVersion?: number
}): DeployWorkflowContractDrift {
	const currentVersion =
		input.currentVersion ?? DEPLOY_WORKFLOW_CONTRACT_VERSION
	const declared = parseExpectedContractFromWorkflowSource(input.workflowSource)
	if (declared === null) {
		return {
			ok: false,
			message: `${deployWorkflowRelativePath} must declare ${expectedContractEnvName} matching tools/ci/deploy-workflow-contract.ts (currently ${String(currentVersion)}).`,
		}
	}
	if (declared !== currentVersion) {
		return {
			ok: false,
			message: `${deployWorkflowRelativePath} declares ${expectedContractEnvName}=${String(declared)} but tools/ci/deploy-workflow-contract.ts is ${String(currentVersion)}. Bump both in the same commit when the tip-of-main workflow gains a checkout-coupled requirement.`,
		}
	}
	return { ok: true, version: currentVersion }
}

export async function checkDeployWorkflowContractDrift(
	cwd: string = process.cwd(),
): Promise<DeployWorkflowContractDrift> {
	const workflowPath = path.join(cwd, deployWorkflowRelativePath)
	const workflowSource = await readFile(workflowPath, 'utf8')
	return assertDeployWorkflowContractDeclaredInWorkflow({ workflowSource })
}

export async function main(): Promise<void> {
	const expectedVersion = parseExpectedContractFromEnv(
		process.env[expectedContractEnvName],
	)
	if (expectedVersion === null) {
		console.error(
			`Missing or invalid ${expectedContractEnvName} for deploy workflow contract guard.`,
		)
		process.exitCode = 1
		return
	}
	const decision = assertCheckoutSatisfiesDeployWorkflowContract({
		checkoutVersion: DEPLOY_WORKFLOW_CONTRACT_VERSION,
		expectedVersion,
	})
	if (!decision.ok) {
		console.error(decision.message)
		process.exitCode = 1
		return
	}
	console.error(
		`Deploy workflow contract ok: checkout v${String(decision.checkoutVersion)} satisfies required v${String(decision.expectedVersion)}.`,
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
