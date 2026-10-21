import { expect, test } from 'vitest'
import { widenSentryEnvironmentType } from './widen-sentry-environment-type.ts'

test('widens the production SENTRY_ENVIRONMENT literal so tests can use preview', () => {
	expect(
		widenSentryEnvironmentType(
			'interface Env {\n\tSENTRY_ENVIRONMENT: "production";\n}\n',
		),
	).toBe('interface Env {\n\tSENTRY_ENVIRONMENT: string;\n}\n')
	expect(widenSentryEnvironmentType('SENTRY_ENVIRONMENT: string;')).toBe(
		'SENTRY_ENVIRONMENT: string;',
	)
})
