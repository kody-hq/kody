import { expect, test } from 'vitest'
import { createPackageStorageHelperPrelude } from './storage-runner.ts'

test('packageStorage prelude passes the writable SQL flag', () => {
	expect(createPackageStorageHelperPrelude()).toContain(
		"__kodyCallDispatcher('packageStorageGet'",
	)
	expect(createPackageStorageHelperPrelude()).toContain('writable: true')
})
