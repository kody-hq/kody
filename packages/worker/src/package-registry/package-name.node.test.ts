import { packageAppHostReservedPackageLeafMessage } from '@kody-internal/shared/package-app-host-paths.ts'
import { expect, test } from 'vitest'
import {
	getPackageNameLeaf,
	getPackageNameScope,
	invalidPackageNameMessage,
	mismatchedPackageScopeMessage,
	normalizePackageNameInput,
	PackageNameInputError,
} from './package-name.ts'

test('normalizePackageNameInput accepts a leaf, strips a matching scope, and rejects a foreign scope', () => {
	expect(
		normalizePackageNameInput({
			value: 'mailchimp',
			ownerScope: 'grant',
			action: 'create',
		}),
	).toBe('mailchimp')
	expect(
		normalizePackageNameInput({
			value: '@grant/mailchimp',
			ownerScope: 'grant',
			action: 'create',
		}),
	).toBe('mailchimp')
	expect(
		normalizePackageNameInput({
			value: '  @Grant/mailchimp  ',
			ownerScope: '@grant',
			action: 'resolve',
		}),
	).toBe('mailchimp')

	expect(() =>
		normalizePackageNameInput({
			value: '@other/mailchimp',
			ownerScope: 'grant',
			action: 'create',
		}),
	).toThrow(PackageNameInputError)
	expect(() =>
		normalizePackageNameInput({
			value: '@other/mailchimp',
			ownerScope: 'grant',
			action: 'create',
		}),
	).toThrow(
		mismatchedPackageScopeMessage({
			value: '@other/mailchimp',
			requestedScope: 'other',
			ownerScope: 'grant',
		}),
	)

	expect(() =>
		normalizePackageNameInput({
			value: 'Not_A_Valid_Id',
			ownerScope: 'grant',
			action: 'create',
		}),
	).toThrow(PackageNameInputError)
	expect(() =>
		normalizePackageNameInput({
			value: 'Not_A_Valid_Id',
			ownerScope: 'grant',
			action: 'create',
		}),
	).toThrow(
		invalidPackageNameMessage({
			value: 'Not_A_Valid_Id',
			ownerScope: 'grant',
			action: 'create',
		}),
	)

	// Org page separator `/@owner/-/<section>` must never be a valid kody.id.
	expect(() =>
		normalizePackageNameInput({
			value: '-',
			ownerScope: 'grant',
			action: 'create',
		}),
	).toThrow(PackageNameInputError)

	expect(getPackageNameLeaf('@kentcdodds/cursor-cloud-agents')).toBe(
		'cursor-cloud-agents',
	)
	expect(getPackageNameScope('@kentcdodds/cursor-cloud-agents')).toBe(
		'kentcdodds',
	)
})

test('normalizePackageNameInput create refuses package-app host reserved leaves', () => {
	expect(() =>
		normalizePackageNameInput({
			value: 'packages',
			ownerScope: 'grant',
			action: 'create',
		}),
	).toThrow(packageAppHostReservedPackageLeafMessage('packages'))
	expect(() =>
		normalizePackageNameInput({
			value: '@grant/packages',
			ownerScope: 'grant',
			action: 'create',
		}),
	).toThrow(PackageNameInputError)

	// Resolve still accepts reserved leaves so existing packages keep working.
	expect(
		normalizePackageNameInput({
			value: 'packages',
			ownerScope: 'grant',
			action: 'resolve',
		}),
	).toBe('packages')
})
