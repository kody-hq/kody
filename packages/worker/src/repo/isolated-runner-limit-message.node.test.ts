import { expect, test } from 'vitest'
import {
	artifactBuildFailureMessage,
	externalPublishResourceLimitMessage,
	publishComputeLimitMessage,
	repoCheckStepResourceLimitAdvice,
	uploadedBuildPersistLimitMessage,
} from './isolated-runner-limit-message.ts'
import { authoringChecksResourceLimitMessage } from './isolated-check-phases.ts'

test('every compute-limit message names the local and execution-context publish path', () => {
	for (const message of [
		repoCheckStepResourceLimitAdvice(null),
		repoCheckStepResourceLimitAdvice('lint'),
		repoCheckStepResourceLimitAdvice('bundle'),
		publishComputeLimitMessage('typecheck'),
		externalPublishResourceLimitMessage('rebuild'),
		authoringChecksResourceLimitMessage('credentials'),
	]) {
		expect(message).toContain(
			'npx -y @kodycodes/cli@latest package publish <package> --build local',
		)
		expect(message).toContain('`--context <name>`')
		expect(message).toContain('https://kody.codes/docs/execution-contexts')
		expect(message).toContain('https://kody.codes/docs/publish-large-packages')
	}
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

test('an in-isolate memory error from an artifact build names the kody:@ cost and the fix', () => {
	const platform = 'Dynamic import exceeded memory limits'
	const check = artifactBuildFailureMessage(platform, 'check')
	const rebuild = artifactBuildFailureMessage(platform, 'rebuild')
	expect(check).toContain(platform)
	expect(check).toContain('kody:@')
	expect(check).toContain(
		'npx -y @kodycodes/cli@latest package publish <package> --build local',
	)
	expect(check).toMatch(/isolated check runner/)
	expect(rebuild).toMatch(/isolated rebuild runner/)
	expect(rebuild).not.toBe(check)
	expect(artifactBuildFailureMessage('Unexpected token', 'rebuild')).toBe(
		'Unexpected token',
	)
	expect(
		artifactBuildFailureMessage('Unexpected token', 'check'),
	).not.toContain('kody:@')
})

test('the uploaded-build limit message does not send a local builder back to build locally', () => {
	const message = uploadedBuildPersistLimitMessage()
	expect(message).toContain('Your build was not rebuilt')
	expect(message).not.toContain('--build local')
	expect(message).not.toContain('--context')
})
