import { realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

/**
 * Pre-push `vitest related` with a fan-out cap (#4995, #5062). A pushed file
 * imported across the worker (a capability registry, a shared type) relates to
 * most of a project, so the hook ran ~1,000 files for a one-line change. Above
 * the cap, run only the pushed tests and same-named test siblings; CI runs the
 * full suites.
 *
 *   node tools/vitest-related-capped.ts --project node-unit <paths...>
 */

export const defaultPrePushRelatedTestCap = 150

const capEnvName = 'KODY_PRE_PUSH_RELATED_TEST_CAP'
const testFilePattern = /\.test\.[cm]?[jt]sx?$/
const sourceExtensionPattern = /\.[cm]?[jt]sx?$/

/** `all` runs every related test; anything else falls back to the default. */
export function prePushRelatedTestCap(env: NodeJS.ProcessEnv = process.env) {
	const raw = env[capEnvName]?.trim()
	if (!raw) return defaultPrePushRelatedTestCap
	if (raw.toLowerCase() === 'all') return Number.POSITIVE_INFINITY
	const cap = Number(raw)
	return Number.isInteger(cap) && cap >= 0 ? cap : defaultPrePushRelatedTestCap
}

/** Pushed test files plus `<stem>.test.ts` / `<stem>.*.test.ts` siblings of pushed sources. */
export function directRelatedTestFiles(input: {
	related: ReadonlyArray<string>
	pushed: ReadonlyArray<string>
}) {
	const pushed = new Set(input.pushed)
	const stems = new Set(
		input.pushed
			.filter((path) => !testFilePattern.test(path))
			.map((path) => basename(path).replace(sourceExtensionPattern, '')),
	)
	return input.related.filter((file) => {
		if (pushed.has(file)) return true
		const testStem = basename(file).replace(testFilePattern, '')
		for (const stem of stems) {
			if (testStem === stem || testStem.startsWith(`${stem}.`)) return true
		}
		return false
	})
}

export function selectPrePushRelatedTests(input: {
	related: ReadonlyArray<string>
	pushed: ReadonlyArray<string>
	cap: number
}) {
	if (input.related.length <= input.cap) {
		return { files: [...input.related], capped: false }
	}
	return { files: directRelatedTestFiles(input), capped: true }
}

/** Vitest module IDs are realpath'd with `/` separators; match pushed paths to them. */
function normalizeModulePath(path: string) {
	let real = path
	try {
		real = realpathSync(path)
	} catch {}
	return real.replaceAll('\\', '/')
}

async function main() {
	const args = process.argv.slice(2)
	const projectIndex = args.indexOf('--project')
	const project = projectIndex === -1 ? undefined : args[projectIndex + 1]
	if (!project) {
		console.error('vitest-related-capped: expected --project <name>')
		return 1
	}
	const pushed = args
		.filter((_, index) => index !== projectIndex && index !== projectIndex + 1)
		.map((path) => normalizeModulePath(resolve(path)))
	const { createVitest } = await import('vitest/node')
	const vitest = await createVitest('test', {
		related: pushed,
		project: [project],
		run: true,
		watch: false,
		passWithNoTests: true,
	})
	try {
		const specs = await vitest.getRelevantTestSpecifications()
		const cap = prePushRelatedTestCap()
		const selection = selectPrePushRelatedTests({
			related: specs.map((spec) => normalizeModulePath(spec.moduleId)),
			pushed,
			cap,
		})
		if (selection.capped) {
			console.log(
				`pre-push: ${specs.length} ${project} test files relate to the pushed paths (cap ${cap}); running ${selection.files.length} pushed or same-named test file(s) and leaving the rest to CI. Set ${capEnvName}=all to run them all.`,
			)
		}
		if (selection.files.length === 0) {
			console.log(`pre-push: no ${project} tests to run`)
			return 0
		}
		// Filters narrow the related set; the import graph is already cached.
		await vitest.start(selection.files)
		return vitest.state.getCountOfFailedTests() > 0 ||
			vitest.state.getUnhandledErrors().length > 0 ||
			(process.exitCode !== undefined && process.exitCode !== 0)
			? 1
			: 0
	} finally {
		await vitest.close()
	}
}

if (isExecutedDirectly(import.meta.url)) {
	process.exitCode = await main()
}
