import { expect, test } from 'vitest'
import {
	credentialCallMapSchema,
	normalizeCredentialCallMap,
} from './credential-call-map.ts'

test('a call map parses names, scoped picks, and lists into picks by key', () => {
	const parsed = credentialCallMapSchema.parse({
		github: 'work',
		google: ['work', { name: 'personal', scope: 'personal' }],
		MAIL_KEY: [],
		'1password': 'vault',
	})
	expect(normalizeCredentialCallMap(parsed)).toEqual(
		new Map([
			['github', [{ name: 'work', scope: null }]],
			[
				'google',
				[
					{ name: 'work', scope: null },
					{ name: 'personal', scope: 'personal' },
				],
			],
			['MAIL_KEY', []],
			['1password', [{ name: 'vault', scope: null }]],
		]),
	)
	expect(normalizeCredentialCallMap({})).toBeNull()
})

test('a call map refuses keys that could collide once trimmed', () => {
	for (const key of [' MAIL', 'MAIL ', '', 'a b', '_x']) {
		expect(
			credentialCallMapSchema.safeParse(JSON.parse(`{"${key}": "work"}`))
				.success,
		).toBe(false)
	}
	expect(
		credentialCallMapSchema.safeParse({ github: { name: 'x', scope: 'team' } })
			.success,
	).toBe(false)
})
