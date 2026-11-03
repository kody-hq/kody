import { getHandleFormatError } from '@kody-internal/shared/handle-rules.ts'
import { getPasswordPolicyError } from '@kody-internal/shared/password-policy.ts'
import type { AuthInvalidField } from '#client/form-error-fields.ts'

// Match the auth handler: any non-empty local@domain after trim. Do not
// require a dotted TLD — accounts like user@localhost must still log in.
const emailShapePattern = /^[^\s@]+@[^\s@]+$/

function getAuthEmailShapeError(email: string): string | null {
	if (!email) return 'Email is required.'
	if (email.length > 254) return 'Email is too long.'
	if (!emailShapePattern.test(email)) return 'Enter a valid email address.'
	return null
}

export type AuthFieldValidation = {
	field: AuthInvalidField
	message: string
}

/**
 * Client-side auth checks that mirror server rules so submit always reaches
 * the handler (forms use `noValidate`) and shows field-tied inline errors.
 */
export function validateAuthFormFields(input: {
	mode: 'login' | 'signup'
	email: string
	password: string
	username: string
}): AuthFieldValidation | null {
	if (input.mode === 'signup') {
		const usernameError = getHandleFormatError(input.username)
		if (usernameError) {
			return { field: 'username', message: usernameError }
		}
	}

	const emailError = getAuthEmailShapeError(input.email)
	if (emailError) return { field: 'email', message: emailError }

	if (!input.password) {
		return { field: 'password', message: 'Password is required.' }
	}
	if (input.mode === 'signup') {
		const passwordError = getPasswordPolicyError(input.password)
		if (passwordError) {
			return { field: 'password', message: passwordError }
		}
	}

	return null
}
