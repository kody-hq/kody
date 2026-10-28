import { expect, test } from 'vitest'
import { adminOrgReturnTo } from './admin-orgs-input.ts'

test('admin org page destinations use the serialized search string', () => {
	const location = {
		pathname: '/admin/orgs',
		searchStr: '?kind=team&q=example',
		search: Object.create(null) as Record<string, string>,
	}

	expect(adminOrgReturnTo(location)).toBe('/admin/orgs?kind=team&q=example')
})
