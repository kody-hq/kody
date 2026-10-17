import { expect, test } from 'vitest'
import { safeTailDiagnostic } from './start-opt-in-diagnostics.ts'
test('tail diagnostics retain only fixed names, compiled frames and known environment keys', () => {
	const value = safeTailDiagnostic({
		exceptions: [
			{
				name: 'TypeError',
				message: 'private-token-value',
				stack:
					'TypeError: private-token-value\n at getEnv (env.ts:12:3)\n at privateFunction (index.js:99:1)\n at leak (https://host/private?secret=value:1:2)',
			},
		],
		logs: [
			{
				message: [
					'Invalid environment variables: COOKIE_SECRET: private-token-value, SECRET_STORE_KEY: private-value',
				],
			},
		],
	})
	expect(value).toEqual({
		errors: [
			{
				name: 'TypeError',
				frames: [
					{ function: 'getEnv', file: 'env.ts', line: 12, column: 3 },
					{ function: 'other', file: 'index.js', line: 99, column: 1 },
				],
			},
		],
		environmentKeys: ['COOKIE_SECRET', 'SECRET_STORE_KEY'],
	})
	expect(JSON.stringify(value)).not.toContain('private')
	expect(JSON.stringify(value)).not.toContain('https')
})
test('arbitrary names, messages and malformed events never become diagnostic output', () => {
	expect(safeTailDiagnostic(null)).toEqual({ errors: [], environmentKeys: [] })
	expect(
		safeTailDiagnostic({
			exceptions: [
				{
					name: 'SecretValue',
					message: 'APP_DB: secret',
					stack: 'arbitrary secret text',
				},
			],
			logs: [{ message: ['private unknown env secret'] }],
		}),
	).toEqual({
		errors: [{ name: 'OtherError', frames: [] }],
		environmentKeys: [],
	})
})
