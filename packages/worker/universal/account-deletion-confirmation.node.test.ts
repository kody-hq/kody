import { expect, test } from 'vitest'
import {
	isAccountDeletedHome,
	isAccountDeletionConfirmation,
} from './account-deletion-confirmation.ts'

test('account deletion confirmation requires the exact GOODBYE KODY phrase', () => {
	expect(isAccountDeletionConfirmation('  GOODBYE KODY  ')).toBe(true)
	expect(isAccountDeletionConfirmation('goodbye kody')).toBe(false)
	expect(isAccountDeletionConfirmation('GOODBYE  KODY')).toBe(false)
	expect(isAccountDeletionConfirmation('')).toBe(false)
})

test('account deleted homepage query is the signed-out confirmation', () => {
	expect(isAccountDeletedHome('?accountDeleted=1')).toBe(true)
	expect(isAccountDeletedHome('accountDeleted=1')).toBe(true)
	expect(isAccountDeletedHome('')).toBe(false)
	expect(isAccountDeletedHome('?accountDeleted=true')).toBe(false)
})
