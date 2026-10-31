import {
	formatLargestNonRuntimePaths,
	type LargePathHint,
} from './publish-size-hints.ts'

const heavyWorkOffloadGuideId = 'heavy_work_offload'

const isolatedCheckRunnerLimitPhrase =
	"exceeded the isolated check runner's memory or CPU limits"
const authoringCheckRunnerLimitPhrase =
	'ran out of memory or CPU time in the check runner'

export function isolatedCheckRunnerLimitMessage(phaseLabel: string) {
	return `${phaseLabel} ${isolatedCheckRunnerLimitPhrase} even on its own.`
}

export function authoringCheckRunnerLimitLead(where: string) {
	return `The publish checks ${authoringCheckRunnerLimitPhrase}${where} before they finished.`
}

/** True for a check result that only says the check runner hit its limits. */
export function isRepoCheckResourceLimitMessage(message: string) {
	return (
		message.includes(isolatedCheckRunnerLimitPhrase) ||
		message.includes(authoringCheckRunnerLimitPhrase)
	)
}

/**
 * Shared advice appended when a throwaway check/rebuild isolate hits a
 * Durable Object memory or CPU reset. The usual cause is the npm graph
 * (PDF.js-class libraries), not the author's source files.
 */
export function isolatedRunnerResourceLimitAdvice() {
	return (
		'This usually means the npm dependency graph — not just the package ' +
		'source — is too large to bundle inside a Worker isolate. Shrink the ' +
		'graph, or keep the Kody package as a thin orchestrator and offload ' +
		'the heavy work to a process you operate. Load ' +
		`\`search({ entity: "guide:${heavyWorkOffloadGuideId}" })\`.`
	)
}

/**
 * Coarse authoring-check step that was running when an isolate hit its
 * memory or CPU limit. Callers record it in Durable Object storage before
 * each step so a reset can still say which step blew the limit.
 */
export type RepoCheckStep =
	| 'clone'
	| 'source-walk'
	| 'credentials'
	| 'package-checks'
	| 'lint'
	| 'bundle'
	| 'typecheck'
	| 'finalize'
	| 'rebuild'

const repoCheckStepLabels: Record<RepoCheckStep, string> = {
	clone: 'cloning the package repo',
	'source-walk': 'reading the package source tree',
	credentials: 'the credential stamp scan',
	'package-checks':
		'the package checks (credential needs, app surface, docs, and skills)',
	lint: 'the lint check',
	bundle: 'bundle validation',
	typecheck: 'the TypeScript typecheck',
	finalize: 'finalizing the publish',
	rebuild: 'the published artifact rebuild',
}

export function repoCheckStepLabel(step: RepoCheckStep) {
	return repoCheckStepLabels[step]
}

export function isRepoCheckStep(value: unknown): value is RepoCheckStep {
	return typeof value === 'string' && Object.hasOwn(repoCheckStepLabels, value)
}

const sourceTreeAdvice =
	'This step reads every non-test .js/.ts module under the package source ' +
	'root, so its cost grows with the total source size even when the ' +
	'runtime code is small. Move scripts, fixtures, generated or vendored ' +
	'code, and examples out of the package source root, list them in a ' +
	'`.kodyignore` file next to package.json, or name test-only modules ' +
	'*.test.ts, then run `kody dev check` again.'

/**
 * Isolate memory and CPU use is not exactly repeatable: garbage collection
 * timing and other work sharing the isolate move the peak between runs.
 */
export const resourceLimitVarianceNote =
	'Memory and CPU use vary between runs (garbage collection timing and ' +
	'other work sharing the isolate), so a tree near the limit can pass on ' +
	'one attempt and fail on the next. Shrink what the checks read instead ' +
	'of retrying.'

/** What the author can do when `step` hits the isolate memory/CPU limit. */
export function repoCheckStepResourceLimitAdvice(step: RepoCheckStep | null) {
	switch (step) {
		case 'clone':
			return (
				'Remove large files that should not be published (build output, ' +
				'vendored dependencies, data files) from the repo and push again.'
			)
		case 'source-walk':
		case 'credentials':
		case 'package-checks':
		case 'lint':
		case 'typecheck':
			return sourceTreeAdvice
		case 'bundle':
		case 'rebuild':
			return isolatedRunnerResourceLimitAdvice()
		case 'finalize':
		case null:
			return `${sourceTreeAdvice} ${isolatedRunnerResourceLimitAdvice()}`
		default: {
			const exhaustive: never = step
			throw new Error(`Unexpected repo check step: ${String(exhaustive)}`)
		}
	}
}

/**
 * Caller-facing copy when `packagePublishExternalPush` dies on a Durable
 * Object isolate memory/CPU reset (or DO SQLite SQLITE_NOMEM). A tree near
 * the limit fails most attempts, so the publish path must not burn retries
 * as if they were deploy-time code-updated blips.
 */
export function externalPublishResourceLimitMessage(
	step: RepoCheckStep | null = null,
) {
	const where = step
		? `during ${repoCheckStepLabel(step)}`
		: 'while cloning, checking, or rebuilding this package'
	return (
		'packagePublishExternalPush hit the Durable Object isolate memory or ' +
		`CPU limit ${where}, so the publish stopped instead of retrying the ` +
		`same limit. ${resourceLimitVarianceNote} ` +
		`${repoCheckStepResourceLimitAdvice(step)} \`kody dev check\` runs the ` +
		'same checks under the same limits, so use it to confirm a fix before ' +
		'publishing again.'
	)
}

const publishComputeLimitPhrase = 'exceeded a Kody compute limit'

/**
 * Caller-facing copy when one publish step, already running in its own
 * throwaway isolate, still hits the Durable Object CPU time or memory limit.
 * A plain retry of the same tree usually hits the same limit; this is never
 * a storage outage. `largestPaths` names what the author could `.kodyignore`.
 */
export function publishComputeLimitMessage(
	step: RepoCheckStep | null = null,
	largestPaths: Array<LargePathHint> = [],
) {
	const where = step ? ` during ${repoCheckStepLabel(step)}` : ''
	return [
		`This publish ${publishComputeLimitPhrase} (Durable Object CPU time or ` +
			`memory)${where}, so it stopped before it finished. This is not a ` +
			`storage outage. ${resourceLimitVarianceNote}`,
		repoCheckStepResourceLimitAdvice(step),
		formatLargestNonRuntimePaths(largestPaths),
		'`kody dev check` runs the same checks under the same limits, so use ' +
			'it to confirm a fix before publishing again.',
	]
		.filter(Boolean)
		.join(' ')
}

/** True for {@link publishComputeLimitMessage} and the external push copy. */
export function isPublishComputeLimitMessage(message: string) {
	return (
		message.includes(publishComputeLimitPhrase) ||
		message.includes(
			'packagePublishExternalPush hit the Durable Object isolate memory or CPU limit',
		)
	)
}
