import { expect, test } from 'vitest'
import { createUiFeedback } from './ui-feedback.ts'
test('feedback is atomic and empty feedback has no stale tone', () => {
	expect(createUiFeedback(null, 'error')).toBeNull()
	expect(createUiFeedback(undefined)).toBeNull()
	expect(createUiFeedback('Saved')).toEqual({ tone: 'info', message: 'Saved' })
	expect(createUiFeedback('Failed', 'error')).toEqual({
		tone: 'error',
		message: 'Failed',
	})
	expect(createUiFeedback('')).toEqual({ tone: 'info', message: '' })
})
