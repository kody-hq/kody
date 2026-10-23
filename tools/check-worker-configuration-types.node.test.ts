import { expect, test } from 'vitest'
import { workerConfigurationTypesDrift } from './check-worker-configuration-types.ts'

test('worker configuration type drift samples the first mismatched lines', () => {
	expect(workerConfigurationTypesDrift('a\nb\n', 'a\nb\n')).toBeNull()
	expect(workerConfigurationTypesDrift('a\nb\n', 'a\nc\n')).toEqual([
		'line 2\n- b\n+ c',
	])
})
