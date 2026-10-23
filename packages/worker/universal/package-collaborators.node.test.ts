import { expect, test } from 'vitest'
import {
	isPackageCollaboratorPreset,
	packageCollaboratorsHref,
	readPackageCollaboratorInvitee,
	readPackageCollaboratorsPath,
} from './package-collaborators.ts'

test('reads the package collaborators path and rejects org pages', () => {
	expect(
		readPackageCollaboratorsPath('/@acme/release-notes/collaborators'),
	).toEqual({
		username: 'acme',
		kodyId: 'release-notes',
	})
	expect(readPackageCollaboratorsPath('/@acme/-/collaborators')).toBeNull()
	expect(
		readPackageCollaboratorsPath('/@acme/release-notes/settings'),
	).toBeNull()
	expect(
		readPackageCollaboratorsPath('/@acme/%E0%A4%A/collaborators'),
	).toBeNull()
	expect(
		packageCollaboratorsHref({ username: 'acme', kodyId: 'release-notes' }),
	).toBe('/@acme/release-notes/collaborators')
})

test('accepts only the shared grant presets', () => {
	expect(
		['use', 'contribute', 'manage'].every(isPackageCollaboratorPreset),
	).toBe(true)
	expect(isPackageCollaboratorPreset('owner')).toBe(false)
	expect(isPackageCollaboratorPreset(null)).toBe(false)
})

test('reads an invitee as an email or a username with or without @', () => {
	expect(readPackageCollaboratorInvitee(' jesse@example.com ')).toEqual({
		email: 'jesse@example.com',
	})
	expect(readPackageCollaboratorInvitee('@jesse')).toEqual({
		username: 'jesse',
	})
})
