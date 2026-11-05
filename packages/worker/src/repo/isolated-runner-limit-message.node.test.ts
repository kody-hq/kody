import { expect, test } from 'vitest'
import {
	externalPublishResourceLimitMessage,
	publishComputeLimitMessage,
	repoCheckStepResourceLimitAdvice,
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
		expect(message).toContain('kody package publish --build local')
		expect(message).toContain('`--context <name>`')
		expect(message).toContain(
			'https://kody.codes/docs/execution-contexts#try-publishing-from-a-context',
		)
		expect(message).toContain('https://kody.codes/docs/publish-large-packages')
	}
})
