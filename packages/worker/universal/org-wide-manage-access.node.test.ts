import { expect, test } from 'vitest'
import {
	heldOrgWideManageOptions,
	orgWideManagePermissionsFor,
} from './org-wide-manage-access.ts'

test('saving one manage kind keeps a partial grant on the other', () => {
	const held = ['package:execute']
	expect(heldOrgWideManageOptions(held)).toEqual([])
	expect(orgWideManagePermissionsFor(['app'], held)).toEqual([
		'package:execute',
		'app:execute',
		'app:manage_access',
	])
})

test('unchecking a fully held kind removes it', () => {
	const held = orgWideManagePermissionsFor(['package', 'app'])
	expect(heldOrgWideManageOptions(held)).toEqual(['package', 'app'])
	expect(orgWideManagePermissionsFor(['app'], held)).toEqual([
		'app:execute',
		'app:manage_access',
	])
})
