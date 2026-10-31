import { expect, test } from 'vitest'
import { rebaseMemberCreationDraft } from './org-settings-member-creation-draft.ts'

const defaults = { packages: false, credentials: true }

test('an untouched draft follows a refetched saved value', () => {
	expect(
		rebaseMemberCreationDraft(defaults, defaults, {
			packages: false,
			credentials: false,
		}),
	).toEqual({ packages: false, credentials: false })
})

test('local edits survive a refetch while untouched fields rebase', () => {
	const draft = { packages: true, credentials: true }
	const next = { packages: false, credentials: false }
	expect(rebaseMemberCreationDraft(draft, defaults, next)).toEqual({
		packages: true,
		credentials: false,
	})
})

test('a refetch that matches the local edit keeps it', () => {
	const draft = { packages: true, credentials: true }
	const next = { packages: true, credentials: true }
	expect(rebaseMemberCreationDraft(draft, defaults, next)).toEqual(next)
})

test('missing values fall back to the new saved value', () => {
	expect(rebaseMemberCreationDraft(null, defaults, defaults)).toEqual(defaults)
	expect(rebaseMemberCreationDraft(defaults, null, defaults)).toEqual(defaults)
	expect(rebaseMemberCreationDraft(defaults, defaults, null)).toBeNull()
})
