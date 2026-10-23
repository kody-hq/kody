import { expect, test } from 'vitest'
import {
	pathnameFromAppUrl,
	shouldIgnorePasswordManagerPage,
} from './password-manager-page-ignore.ts'

test('only login and signup stay fillable for 1Password', () => {
	expect(shouldIgnorePasswordManagerPage('/login')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/signup')).toBe(false)
	expect(shouldIgnorePasswordManagerPage('/account')).toBe(true)
	expect(shouldIgnorePasswordManagerPage('/login/extra')).toBe(true)
})

test('document urls keep only the pathname', () => {
	expect(pathnameFromAppUrl('/admin/users?q=kent#row')).toBe('/admin/users')
	expect(pathnameFromAppUrl(undefined)).toBe('/')
})
