/**
 * Local `npm run validate` check list and how many legs may run at once.
 *
 * GitHub Actions runs the same checks as separate jobs, each on its own
 * runner. This module is the local gate. Suite legs are sized like those
 * jobs (node unit uses 3 workers when `CI=1`). Starting every suite and
 * every worker dry-run together fills a 4-core machine and exhausts a 16GB
 * VM (#3147). Cap those legs there. Larger machines still start every leg
 * together. No check is skipped on either size.
 */

type ValidateLegWeight = 'suite' | 'build' | 'check'

export type ValidateLeg = {
	name: string
	command: string
	weight: ValidateLegWeight
}

/** One suite leg saturates a machine this small. CI node unit uses 3 workers. */
export const saturatedSuiteParallelism = 4

/**
 * RAM below this cannot hold several suite legs plus worker dry-runs.
 * The failing Cloud Agent VM has 16GB. The floor sits above that.
 */
export const saturatedSuiteMemoryBytes = 24 * 1024 * 1024 * 1024

export const serialValidateCommand = 'npm run worker-startup-time:check'

export const parallelValidateLegs = [
	{ name: 'format', command: 'npm run format:check', weight: 'check' },
	{ name: 'lint', command: 'npm run lint', weight: 'check' },
	{ name: 'typecheck', command: 'npm run typecheck', weight: 'suite' },
	{
		name: 'worker-types',
		command: 'npm run generate-types:check',
		weight: 'check',
	},
	{ name: 'test-node', command: 'CI=1 npm run test:node', weight: 'suite' },
	{
		name: 'test-workers',
		command: 'CI=1 KODY_VALIDATE_LOAD=1 npm run test:workers',
		weight: 'suite',
	},
	{ name: 'e2e', command: 'CI=1 npm run test:e2e:run', weight: 'suite' },
	{ name: 'mcp', command: 'CI=1 npm run test:mcp', weight: 'suite' },
	{ name: 'backup-build', command: 'npm run backup:build', weight: 'build' },
	{ name: 'status-build', command: 'npm run status:build', weight: 'build' },
	{
		name: 'nx-cache-build',
		command: 'npm run nx-cache:build',
		weight: 'build',
	},
	{ name: 'jobs-build', command: 'npm run jobs:build', weight: 'build' },
	{
		name: 'highlight-build',
		command: 'npm run highlight:build',
		weight: 'build',
	},
	{
		name: 'push-queue-build',
		command: 'npm run push-queue:build',
		weight: 'build',
	},
	{ name: 'api-build', command: 'npm run api:build', weight: 'build' },
	{
		name: 'api-docs-build',
		command: 'npm run api-docs:build',
		weight: 'build',
	},
	{
		name: 'runtime-build',
		command: 'npm run runtime:build',
		weight: 'build',
	},
	{
		name: 'platform-build',
		command: 'npm run platform:build',
		weight: 'build',
	},
	{
		name: 'startup',
		command: 'npm run worker-startup-bundles:check',
		weight: 'build',
	},
	{
		name: 'primitives',
		command: 'npm run primitives:check',
		weight: 'check',
	},
	{
		name: 'migrations',
		command: 'npm run migrations:check',
		weight: 'check',
	},
	{
		name: 'deploy-guardrails',
		command: 'npm run deploy-guardrails:check',
		weight: 'check',
	},
	{ name: 'workflows', command: 'npm run workflows:check', weight: 'check' },
	{
		name: 'origin-production-exports',
		command: 'npm run origin-production-exports:check',
		weight: 'check',
	},
	{
		name: 'docs',
		command: 'npm run docs:check',
		weight: 'check',
	},
	{
		name: 'deps',
		command: 'npm run deps:check',
		weight: 'check',
	},
	{
		name: 'soft-delete-filter',
		command: 'npm run soft-delete-read-filter:check',
		weight: 'check',
	},
	{
		name: 'error-agent-prompt',
		command: 'npm run error-agent-prompt:check',
		weight: 'check',
	},
	{
		name: 'slop-ratchet',
		command: 'npm run slop-ratchet:check',
		weight: 'check',
	},
	{ name: 'knip', command: 'npm run knip', weight: 'build' },
	{ name: 'cli', command: 'npm run cli:validate', weight: 'build' },
	{
		name: 'cli-openapi',
		command: 'npm run cli:openapi:check',
		weight: 'check',
	},
	{ name: 'audit', command: 'npm run audit:prod', weight: 'check' },
] as const satisfies readonly ValidateLeg[]

const legNames = new Set<string>()
for (const leg of parallelValidateLegs) {
	if (legNames.has(leg.name)) {
		throw new Error(`Duplicate validate leg: ${leg.name}`)
	}
	legNames.add(leg.name)
	if (leg.command.trim() === '') {
		throw new Error(`Empty validate command: ${leg.name}`)
	}
}

export type ValidateSlots = {
	/** `undefined` starts every leg in that weight together. */
	suite: number | undefined
	build: number | undefined
	check: number | undefined
}

export function validateConcurrency(input: {
	availableParallelism: number
	totalMemoryBytes: number
}): ValidateSlots {
	const smallMachine =
		input.availableParallelism <= saturatedSuiteParallelism ||
		input.totalMemoryBytes < saturatedSuiteMemoryBytes
	if (!smallMachine) {
		return { suite: undefined, build: undefined, check: undefined }
	}
	return {
		suite: 1,
		build: 1,
		check: Math.max(1, input.availableParallelism),
	}
}

export function validateLegsByWeight(
	legs: readonly ValidateLeg[] = parallelValidateLegs,
) {
	return {
		suite: legs.filter((leg) => leg.weight === 'suite'),
		build: legs.filter((leg) => leg.weight === 'build'),
		check: legs.filter((leg) => leg.weight === 'check'),
	}
}

export function formatValidatePlan(input: {
	availableParallelism: number
	totalMemoryBytes: number
	slots: ValidateSlots
}) {
	const memoryMb = Math.round(input.totalMemoryBytes / (1024 * 1024))
	const slot = (value: number | undefined) =>
		value === undefined ? 'unbounded' : String(value)
	return `validate: ${input.availableParallelism} cores, ${memoryMb}MB RAM; suite slots ${slot(input.slots.suite)}, build slots ${slot(input.slots.build)}, check slots ${slot(input.slots.check)}`
}
