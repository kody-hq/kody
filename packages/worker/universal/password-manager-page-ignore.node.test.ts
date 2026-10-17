import { jsx } from 'react/jsx-runtime'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import {
	passwordManagerPageIgnoreAttribute,
	passwordManagerPageIgnoreProps,
	pathnameFromAppUrl,
	shouldIgnorePasswordManagerPage,
} from './password-manager-page-ignore.ts'

test('only login and signup stay fillable for 1Password', () => {
	expect(shouldIgnorePasswordManagerPage('/login')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/signup')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/account')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/login/extra')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/signup/extra')).toBe(true)
})

test('document urls keep only the pathname', () => {
	expect(pathnameFromAppUrl('/admin/users?q=kent#row')).toBe('/admin/users')
	expect(pathnameFromAppUrl('/login')).toBe('/login')
	expect(pathnameFromAppUrl(undefined)).toBe('/')
})

test('body markup carries data-1p-ignore except on login and signup', async () => {
	const adminHtml = await renderToString(
		jsx('body', {
			...passwordManagerPageIgnoreProps('/admin/users'),
			children: 'Users',
		}),
	)
	expect(adminHtml).toContain('<body data-1p-ignore="true">')

	const accountHtml = await renderToString(
		jsx('body', {
			...passwordManagerPageIgnoreProps('/account'),
			children: 'Account',
		}),
	)
	expect(accountHtml).toContain(passwordManagerPageIgnoreAttribute)

	const loginHtml = await renderToString(
		jsx('body', {
			...passwordManagerPageIgnoreProps('/login'),
			children: 'Login',
		}),
	)
	expect(loginHtml).not.toContain(passwordManagerPageIgnoreAttribute)
	expect(loginHtml).toContain('<body>')

	const signupHtml = await renderToString(
		jsx('body', {
			...passwordManagerPageIgnoreProps('/signup'),
			children: 'Signup',
		}),
	)
	expect(signupHtml).not.toContain(passwordManagerPageIgnoreAttribute)
})
