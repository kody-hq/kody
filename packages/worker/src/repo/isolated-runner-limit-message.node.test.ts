import { expect, test } from 'vitest'
import { isolatedRunnerResourceLimitAdvice } from './isolated-runner-limit-message.ts'

test('resource-limit advice explains local and context publish builds and links the docs', () => {
	const advice = isolatedRunnerResourceLimitAdvice()
	expect(advice).toContain('kody package publish <package> --build local')
	expect(advice).toContain('kody package publish <package> --build context')
	expect(advice).toContain('https://kody.codes/docs/publish-large-packages')
})
