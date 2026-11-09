import { expect, test } from 'vitest'
import {
	findIdentityIconPath,
	identityIconLeafName,
	identityIconMonogramLetter,
	isIdentityIconSourcePath,
	packageAppIdentityIconPath,
} from './identity-icon-paths.ts'

test('canonical .kody/icon wins over root and community-icon aliases', () => {
	expect(
		findIdentityIconPath({
			'.kody/icon.png': '',
			'icon.svg': '',
			'community-icon.svg': '',
			[packageAppIdentityIconPath]: '',
		}),
	).toBe('.kody/icon.png')
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
	expect(findIdentityIconPath({ [packageAppIdentityIconPath]: '' })).toBeNull()
	expect(
		findIdentityIconPath(
			{ [packageAppIdentityIconPath]: '' },
			{ includePackageAppIcon: true },
		),
	).toBe(packageAppIdentityIconPath)
})

test('identity source paths exclude other icon files', () => {
	expect(isIdentityIconSourcePath('.kody/icon.png')).toBe(true)
	expect(isIdentityIconSourcePath(packageAppIdentityIconPath)).toBe(true)
	expect(isIdentityIconSourcePath('public/icon.png')).toBe(false)
})

test('leaf name and monogram letter come from the package/repo leaf', () => {
	expect(identityIconLeafName('@kentcdodds/github-tools')).toBe('github-tools')
	expect(identityIconLeafName('plain-repo')).toBe('plain-repo')
	expect(identityIconMonogramLetter('@kentcdodds/github-tools')).toBe('G')
	expect(identityIconMonogramLetter('123-notes')).toBe('1')
	expect(identityIconMonogramLetter('')).toBe('R')
})
