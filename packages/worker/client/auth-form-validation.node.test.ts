import { expect, test } from 'vitest'
import { validateAuthFormFields } from './auth-form-validation.ts'

test('signup rejects invalid username with a field-tied message', () => {
	expect(
		validateAuthFormFields({
			mode: 'signup',
			username: 'Ján Kováč',
			email: 'jan@example.com',
			password: 'password123',
		}),
	).toEqual({
		field: 'username',
		message:
			'Username can only use a–z letters (no accents), numbers, and hyphens.',
	})
})

test('signup trims username whitespace before validating', () => {
	expect(
		validateAuthFormFields({
			mode: 'signup',
			username: 'kent ',
			email: 'kent@example.com',
			password: 'password123',
		}),
	).toBeNull()
})

test('signup rejects short passwords and bad emails', () => {
	expect(
		validateAuthFormFields({
			mode: 'signup',
			username: 'kent',
			email: 'not-an-email',
			password: 'password123',
		}),
	).toEqual({
		field: 'email',
		message: 'Enter a valid email address.',
	})
	expect(
		validateAuthFormFields({
			mode: 'login',
			username: '',
			email: 'user@localhost',
			password: 'x',
		}),
	).toBeNull()
	expect(
		validateAuthFormFields({
			mode: 'signup',
			username: 'kent',
			email: 'kent@example.com',
			password: 'short',
		}),
	).toEqual({
		field: 'password',
		message: 'Password must be at least 8 characters.',
	})
})

test('login only requires email shape and a non-empty password', () => {
	expect(
		validateAuthFormFields({
			mode: 'login',
			username: '',
			email: 'kent@example.com',
			password: 'x',
		}),
	).toBeNull()
	expect(
		validateAuthFormFields({
			mode: 'login',
			username: '',
			email: '',
			password: 'x',
		}),
	).toEqual({ field: 'email', message: 'Email is required.' })
})
