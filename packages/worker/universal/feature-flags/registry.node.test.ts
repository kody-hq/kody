import { expect, test } from 'vitest'
import {
	featureFlagDefinitions,
	type FeatureFlagDefinition,
} from './registry.ts'

const reviewDatePattern = /^\d{4}-\d{2}-\d{2}$/

test('every feature flag says how it ends', () => {
	const missing = featureFlagDefinitions
		.filter((definition: FeatureFlagDefinition) => {
			const removeWhen = definition.removeWhen?.trim() ?? ''
			return !removeWhen && !definition.reviewBy
		})
		.map((definition) => definition.key)
	expect(missing).toEqual([])
})

test('every reviewBy is a real date that has not passed', () => {
	const today = new Date().toISOString().slice(0, 10)
	const problems = featureFlagDefinitions.flatMap(
		(definition: FeatureFlagDefinition) => {
			const reviewBy = definition.reviewBy
			if (!reviewBy) return []
			const valid =
				reviewDatePattern.test(reviewBy) &&
				new Date(`${reviewBy}T00:00:00Z`).toISOString().startsWith(reviewBy)
			if (!valid)
				return [`${definition.key}: reviewBy ${reviewBy} is not a date`]
			if (reviewBy < today) {
				return [
					`${definition.key}: reviewBy ${reviewBy} has passed. Remove the flag, or set a new reviewBy and update removeWhen.`,
				]
			}
			return []
		},
	)
	expect(problems).toEqual([])
})
