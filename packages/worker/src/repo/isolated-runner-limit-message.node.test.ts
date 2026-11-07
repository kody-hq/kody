import { expect, test } from 'vitest'
import {
	externalPublishResourceLimitMessage,
	publishComputeLimitMessage,
	repoCheckStepResourceLimitAdvice,
} from './isolated-runner-limit-message.ts'
import {
	authoringChecksResourceLimitMessage,
	runAuthoringChecksInIsolate,
} from './isolated-check-phases.ts'

test('every compute-limit message names the local and execution-context publish path', () => {
	for (const message of [
		repoCheckStepResourceLimitAdvice(null),
		repoCheckStepResourceLimitAdvice('lint'),
		repoCheckStepResourceLimitAdvice('bundle'),
		publishComputeLimitMessage('typecheck'),
		externalPublishResourceLimitMessage('rebuild'),
		authoringChecksResourceLimitMessage('credentials'),
	]) {
		expect(message).toContain('kody package publish --build local')
		expect(message).toContain('`--context <name>`')
		expect(message).toContain(
			'https://kody.codes/docs/execution-contexts#try-publishing-from-a-context',
		)
		expect(message).toContain('https://kody.codes/docs/publish-large-packages')
	}
})

const isolateReset = () =>
	new Error("Durable Object's isolate exceeded its memory limit and was reset.")

/** A check isolate that always resets, with `lastStep` as its step marker. */
function resettingCheckEnv(lastStep: string | null) {
	const store = new Map<string, unknown>()
	return {
		BUNDLE_ARTIFACTS_KV: {
			get: async (key: string) => store.get(key) ?? null,
			put: async (key: string, value: unknown) => void store.set(key, value),
			delete: async (key: string) => void store.delete(key),
		},
		REPO_SESSION: {
			idFromName: (name: string) => ({ name }),
			get: () => ({
				runIsolatedAuthoringChecks: async () => {
					throw isolateReset()
				},
				takeLastCheckStep: async () => lastStep,
			}),
		},
	} as unknown as Env
}

const packageWithNpmDependency = {
	'package.json': JSON.stringify({
		name: '@example/demo',
		exports: { '.': './src/index.ts' },
		dependencies: { 'example-heavy-lib': '1.0.0' },
	}),
	'src/index.ts':
		"import lib from 'example-heavy-lib'\nexport default async () => lib\n",
	'scripts/generate.ts': 'x'.repeat(40 * 1024),
}

async function checkAfterReset(lastStep: string | null) {
	const outcome = await runAuthoringChecksInIsolate({
		env: resettingCheckEnv(lastStep),
		userId: 'user-1' as Parameters<
			typeof runAuthoringChecksInIsolate
		>[0]['userId'],
		baseUrl: 'https://kody.test',
		files: packageWithNpmDependency,
	})
	expect(outcome?.ok).toBe(false)
	return outcome!.results[0]!
}

test('a credential scan reset is reported as the credential scan, not bundling or npm', async () => {
	const check = await checkAfterReset('credentials')

	expect(check.kind).toBe('credentials')
	expect(check.message).toContain('during the credential stamp scan')
	expect(check.message).toContain('`scripts/generate.ts`')
	expect(check.message).not.toContain('example-heavy-lib')
	expect(check.message).not.toContain('npm')
	expect(check.message).not.toContain('Runtime code reachable')
	expect(check.message).not.toContain('This step bundles')
})

test('a bundle reset still names the runtime graph and npm dependencies', async () => {
	const check = await checkAfterReset('bundle')

	expect(check.kind).toBe('bundle')
	expect(check.message).toContain('during bundle validation')
	expect(check.message).toContain('`example-heavy-lib`')
	expect(check.message).toContain('Runtime code reachable')
})

test('only bundling steps name npm dependencies in compute-limit hints', () => {
	const hints = {
		runtime: {
			fileCount: 1,
			bytes: 2048,
			largest: [{ path: 'src/index.ts', bytes: 2048 }],
		},
		npmDependencies: ['example-heavy-lib'],
		ignorable: [],
	}
	for (const step of ['credentials', 'lint', 'package-checks'] as const) {
		expect(publishComputeLimitMessage(step, hints)).not.toContain(
			'example-heavy-lib',
		)
	}
	expect(publishComputeLimitMessage('typecheck', hints)).toContain(
		'Runtime code reachable',
	)
	expect(publishComputeLimitMessage('typecheck', hints)).not.toContain(
		'example-heavy-lib',
	)
	expect(publishComputeLimitMessage('rebuild', hints)).toContain(
		'example-heavy-lib',
	)
})
