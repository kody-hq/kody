import { expect, test } from 'vitest'
import {
	getReservedUsernameError,
	isPermanentlyReservedUsername,
	isReservedUsername,
	isUsernameEffectivelyReserved,
} from './reserved-usernames.ts'
import { getUsernameValidationError } from './username.ts'

test('reserved username validation rejects brand, support, and infrastructure names', () => {
	for (const reserved of [
		'kody',
		'KODY',
		' support ',
		'postmaster',
		'no-reply',
		'admin',
		'mcp',
		'psl',
		'autodiscover',
		'mta-sts',
		'wpad',
		'kody-r-0123456789abcdef',
	]) {
		expect(isReservedUsername(reserved)).toBe(true)
		expect(getReservedUsernameError(reserved)).not.toBeNull()
		expect(getUsernameValidationError(reserved)).not.toBeNull()
	}

	for (const allowed of ['alice', 'assistant', 'analytics', 'robot']) {
		expect(isReservedUsername(allowed)).toBe(false)
		expect(getReservedUsernameError(allowed)).toBeNull()
		expect(getUsernameValidationError(allowed)).toBeNull()
	}

	expect(isReservedUsername('ab')).toBe(false)
	expect(getUsernameValidationError('ab')).not.toBeNull()
	expect(isPermanentlyReservedUsername('kody')).toBe(true)
	expect(isPermanentlyReservedUsername('support')).toBe(true)
	expect(isPermanentlyReservedUsername('team')).toBe(true)
	expect(isPermanentlyReservedUsername('kody-bot')).toBe(true)
	expect(isPermanentlyReservedUsername('kody-r-deadbeef')).toBe(true)
	expect(isPermanentlyReservedUsername('faq')).toBe(false)
	expect(isPermanentlyReservedUsername('alice')).toBe(false)
	expect(isUsernameEffectivelyReserved('team', { removed: ['team'] })).toBe(
		true,
	)
	// Inbound alias permanent reserve is exact/compact only.
	expect(isReservedUsername('team-one')).toBe(false)
	expect(isReservedUsername('fresh-team')).toBe(false)

	expect(isUsernameEffectivelyReserved('faq', { removed: ['faq'] })).toBe(false)
	expect(
		isUsernameEffectivelyReserved('support', { removed: ['support'] }),
	).toBe(true)
	expect(
		isUsernameEffectivelyReserved('brandnew', { added: ['brandnew'] }),
	).toBe(true)
	expect(
		isUsernameEffectivelyReserved('brandnew', {
			added: ['brandnew'],
			removed: ['brandnew'],
		}),
	).toBe(false)

	expect(isReservedUsername('devnull')).toBe(true)
	expect(isReservedUsername('acmechallenge')).toBe(true)
	expect(isReservedUsername('developer')).toBe(false)
	expect(isReservedUsername('user-me')).toBe(false)
	expect(isReservedUsername('super-help')).toBe(false)
	expect(isReservedUsername('mcp-test-user')).toBe(false)

	const addedSwears = { added: ['fuck', 'ass'] }
	expect(isUsernameEffectivelyReserved('a-ss', addedSwears)).toBe(true)
	expect(isUsernameEffectivelyReserved('a_ss', addedSwears)).toBe(true)
	expect(isUsernameEffectivelyReserved('ass', addedSwears)).toBe(true)
	expect(isUsernameEffectivelyReserved('super-faq')).toBe(false)
	expect(isUsernameEffectivelyReserved('f-aq')).toBe(true)
	expect(isUsernameEffectivelyReserved('super-help')).toBe(false)
	expect(
		isUsernameEffectivelyReserved('super-help', { removed: ['help'] }),
	).toBe(false)
	expect(isUsernameEffectivelyReserved('kent-dodds-fan')).toBe(true)
	expect(isUsernameEffectivelyReserved('my-support-bot')).toBe(true)
})

test('`me` is permanently reserved because /@me routes to the signed-in handle', () => {
	for (const handle of ['me', 'ME', ' Me ', 'm-e', 'M_E']) {
		expect(isReservedUsername(handle)).toBe(true)
		expect(isUsernameEffectivelyReserved(handle, { removed: ['me'] })).toBe(
			true,
		)
	}
	expect(isPermanentlyReservedUsername('me')).toBe(true)
	expect(isPermanentlyReservedUsername('ME')).toBe(true)
	expect(isReservedUsername('user-me')).toBe(false)
	expect(isReservedUsername('meow')).toBe(false)
})
