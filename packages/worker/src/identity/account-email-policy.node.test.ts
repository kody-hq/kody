import { expect, test } from 'vitest'
import { disposableEmailDomainList } from './disposable-email-domains.ts'
import {
	accountEmailTypoSuggestion,
	assessAccountEmailSyntax,
	isDisposableEmailDomain,
	parseAccountEmail,
} from './account-email-policy.ts'

test('parseAccountEmail accepts a normal address and rejects a bare username', () => {
	expect(parseAccountEmail(' Person+Tag@Example.COM ')).toEqual({
		email: 'person+tag@example.com',
		local: 'person+tag',
		domain: 'example.com',
	})
	expect(parseAccountEmail('jjenzz')).toBeNull()
	expect(parseAccountEmail('a@b')).toBeNull()
	expect(parseAccountEmail('a@b.c')).toBeNull()
	expect(parseAccountEmail('name <a@example.com>')).toBeNull()
})

test('typo domains suggest the mailbox the person likely meant', () => {
	expect(assessAccountEmailSyntax('ada@gmial.com')).toEqual({
		ok: false,
		code: 'email_typo',
		error: 'That email domain looks mistyped. Did you mean ada@gmail.com?',
		suggestion: 'ada@gmail.com',
	})
	expect(accountEmailTypoSuggestion('ada@gmal.com')).toBe('ada@gmail.com')
	expect(accountEmailTypoSuggestion('ada@gamil.com')).toBe('ada@gmail.com')
	expect(accountEmailTypoSuggestion('ada@hotmial.com')).toBe('ada@hotmail.com')
	expect(accountEmailTypoSuggestion('ada@yaho.com')).toBe('ada@yahoo.com')
	expect(accountEmailTypoSuggestion('ada@outlok.com')).toBe('ada@outlook.com')
	expect(accountEmailTypoSuggestion('ada@icoud.com')).toBe('ada@icloud.com')
	expect(accountEmailTypoSuggestion('ada@gmail.con')).toBe('ada@gmail.com')
	expect(accountEmailTypoSuggestion('ada@gmial.con')).toBe('ada@gmail.com')
	expect(accountEmailTypoSuggestion('ada@outlook.cmo')).toBe('ada@outlook.com')
	expect(accountEmailTypoSuggestion('ada@company.con')).toBe('ada@company.com')
	expect(accountEmailTypoSuggestion('ada@gmail.com')).toBeNull()
	expect(accountEmailTypoSuggestion('ada@company.co')).toBeNull()
})

test('disposable domains match subdomains and spare real mailbox providers', () => {
	expect(disposableEmailDomainList.length).toBeGreaterThan(1000)
	expect(disposableEmailDomainList).toContain('mailinator.com')
	expect(disposableEmailDomainList).not.toContain('gmail.com')
	expect(isDisposableEmailDomain('mailinator.com')).toBe(true)
	expect(isDisposableEmailDomain('mail.mailinator.com')).toBe(true)
	expect(isDisposableEmailDomain('gmail.com')).toBe(false)
	expect(isDisposableEmailDomain('outlook.com')).toBe(false)
	expect(assessAccountEmailSyntax('ada@mailinator.com').ok).toBe(false)
	expect(assessAccountEmailSyntax('ada@gmail.com')).toEqual({
		ok: true,
		email: 'ada@gmail.com',
	})
})
