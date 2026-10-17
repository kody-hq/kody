import { defaultParseSearch } from '@tanstack/react-router'
import { expect, test } from 'vitest'
import { adminUsersFilters, adminUsersSelection } from './admin-users-input.ts'

test('admin list identity depends on filter values and page size, not selected user or loaded page', () => {
	expect(
		adminUsersFilters(
			defaultParseSearch('?q=ada&role=admin&page=8&selected=one'),
		),
	).toEqual(
		adminUsersFilters(
			defaultParseSearch('?selected=two&role=admin&q=ada&page=1'),
		),
	)
	expect(adminUsersFilters(defaultParseSearch(''))).toEqual({
		query: '',
		role: '',
		verification: '',
		pageSize: 20,
	})
	expect(adminUsersFilters(defaultParseSearch('?pageSize=1000')).pageSize).toBe(
		100,
	)
	expect(
		adminUsersFilters(defaultParseSearch('?pageSize=invalid')).pageSize,
	).toBe(20)
	expect(adminUsersFilters(defaultParseSearch('?pageSize=40')).pageSize).toBe(
		40,
	)
})

test('detail selection preserves path priority and selected-query fallback for invalid IDs', () => {
	const pathId = 'a'.repeat(64)
	const queryId = 'b'.repeat(64)
	expect(
		adminUsersSelection(defaultParseSearch('?selected=' + queryId), pathId),
	).toBe(pathId)
	expect(
		adminUsersSelection(defaultParseSearch('?selected=' + queryId), 'invalid'),
	).toBe(queryId)
	expect(
		adminUsersSelection(defaultParseSearch('?selected=invalid')),
	).toBeNull()
})
