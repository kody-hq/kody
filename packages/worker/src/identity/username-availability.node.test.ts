import { createMigratedDb } from '#worker/test-support/auth-provider-harness.ts'
import { expect, test } from 'vitest'
import {
	checkUsernameAvailability,
	collectUsernameSuggestionCandidates,
} from './username-availability.ts'

test('collectUsernameSuggestionCandidates includes identity seeds and suffixes', () => {
	const candidates = collectUsernameSuggestionCandidates('Ada Lovelace', {
		email: 'ada@example.com',
		providerUsername: 'ada-gh',
		displayName: 'Ada Lovelace',
	})
	expect(candidates).toContain('ada-lovelace')
	expect(candidates).toContain('ada-gh')
	expect(candidates).toContain('ada')
	expect(candidates.some((value) => value.startsWith('ada-lovelace-'))).toBe(
		true,
	)
})

test('checkUsernameAvailability reports available, taken, reserved, and invalid', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('taken-user', 'taken@example.com', 'x', 'taken-stable')`,
		)
		.run()

	const available = await checkUsernameAvailability({
		db,
		username: 'fresh-handle',
	})
	expect(available).toMatchObject({
		username: 'fresh-handle',
		status: 'available',
		reason: null,
		suggestions: [],
	})

	const taken = await checkUsernameAvailability({
		db,
		username: 'taken-user',
		seeds: { email: 'newbie@example.com' },
	})
	expect(taken.status).toBe('taken')
	expect(taken.reason).toContain('taken-user')
	expect(taken.suggestions.length).toBeGreaterThan(0)
	for (const suggestion of taken.suggestions) {
		const recheck = await checkUsernameAvailability({
			db,
			username: suggestion,
		})
		expect(recheck.status).toBe('available')
	}

	const reserved = await checkUsernameAvailability({
		db,
		username: 'support',
		seeds: { displayName: 'Ada Lovelace', email: 'ada@example.com' },
	})
	expect(reserved.status).toBe('reserved')
	expect(reserved.suggestions.length).toBeGreaterThan(0)
	expect(reserved.suggestions).not.toContain('support')

	const invalid = await checkUsernameAvailability({
		db,
		username: 'ab',
	})
	expect(invalid.status).toBe('invalid')
})
