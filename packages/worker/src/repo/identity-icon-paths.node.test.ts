import { expect, test } from 'vitest'
import {
	findIdentityIconPath,
	identityIconLeafName,
	identityIconMonogramLetter,
	isIdentityIconSourcePath,
} from './identity-icon-paths.ts'

test('canonical .kody/icon wins over root and community-icon aliases', () => {
	expect(
		findIdentityIconPath({
			'.kody/icon.png': '',
			'icon.svg': '',
			'community-icon.svg': '',
			'icons/icon-192.png': '',
		}),
	).toBe('.kody/icon.png')
	expect(
		findIdentityIconPath({
			'.kody/icon.png': '',
			'.kody/icon.svg': '',
		}),
	).toBe('.kody/icon.svg')
	expect(
		findIdentityIconPath({
			'icon.png': '',
			'community-icon.svg': '',
		}),
	).toBe('icon.png')
	expect(
		findIdentityIconPath({
			'community-icon.jpeg': '',
			'community-icon.svg': '',
		}),
	).toBe('community-icon.svg')
})

test('package-app icon is last and only when requested', () => {
	expect(findIdentityIconPath({ 'icons/icon-192.png': '' })).toBeNull()
	expect(
		findIdentityIconPath(
			{ 'icons/icon-192.png': '' },
			{ includePackageAppIcon: true },
		),
	).toBe('icons/icon-192.png')
})

test('identity source paths exclude other icon files', () => {
	expect(isIdentityIconSourcePath('.kody/icon.png')).toBe(true)
	expect(isIdentityIconSourcePath('icon.svg')).toBe(true)
	expect(isIdentityIconSourcePath('community-icon.webp')).toBe(true)
	expect(isIdentityIconSourcePath('icons/icon-192.png')).toBe(true)
	expect(isIdentityIconSourcePath('public/icon.png')).toBe(false)
	expect(isIdentityIconSourcePath('icons/icon-512.png')).toBe(false)
})

test('leaf name and monogram letter come from the package/repo leaf', () => {
	expect(identityIconLeafName('@kentcdodds/github-tools')).toBe('github-tools')
	expect(identityIconLeafName('plain-repo')).toBe('plain-repo')
	expect(identityIconLeafName('')).toBe('repo')
	expect(identityIconMonogramLetter('@kentcdodds/github-tools')).toBe('G')
	expect(identityIconMonogramLetter('123-notes')).toBe('1')
	expect(identityIconMonogramLetter('')).toBe('R')
	expect(identityIconMonogramLetter('---')).toBe('?')
})
