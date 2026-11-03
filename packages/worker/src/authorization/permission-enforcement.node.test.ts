import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isGrantablePermission } from '@kody-internal/shared/grant-presets.ts'
import {
	isOrgResourceType,
	orgPermissions,
	type OrgPermission,
} from '@kody-internal/shared/org-permissions.ts'
import { expect, test } from 'vitest'

const workerRoot = fileURLToPath(new URL('../../', import.meta.url))
const sourceRoots = ['src', 'start', 'universal', 'client']

/**
 * Files that only list or describe permissions (registry, presets, token
 * scope copy, legacy rewrites, Grants page options). A permission named only
 * here is grantable but gates nothing.
 */
const vocabularyFiles = new Set([
	'src/api-tokens/legacy-scope-rewrite.ts',
	'src/api-tokens/scopes.ts',
	'src/authorization/member-creation-permissions.ts',
	'universal/org-wide-manage-access.ts',
	'universal/org-wide-read-access.ts',
])

/**
 * Grantable but checked nowhere (kody-hq/kody#3739). App changes and deletion
 * are `package:write` / `package:delete` (an app shares its package's id), so
 * `app:write` / `app:delete` are in no preset and only an advanced app grant
 * can carry them. `job:delete` removal is tracked in #3678.
 */
const unenforcedGrantablePermissions: ReadonlyArray<OrgPermission> = [
	'app:delete',
	'app:write',
	'job:delete',
]

function listSourceFiles(directory: string): Array<string> {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name)
		if (entry.isDirectory()) {
			return entry.name === 'test-support' || entry.name === 'node_modules'
				? []
				: listSourceFiles(path)
		}
		if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
			return []
		}
		return [path]
	})
}

function isGrantable(permission: OrgPermission) {
	const family = permission.split(':')[0]
	return (
		isGrantablePermission('org', permission) ||
		(isOrgResourceType(family) && isGrantablePermission(family, permission))
	)
}

test('every grantable permission is referenced outside the permission vocabulary, except the known unenforced ones', () => {
	const code = sourceRoots
		.flatMap((root) => listSourceFiles(join(workerRoot, root)))
		.filter((file) => !vocabularyFiles.has(relative(workerRoot, file)))
		.map((file) =>
			readFileSync(file, 'utf8')
				.split('\n')
				.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
				.join('\n'),
		)
		.join('\n')

	const unreferenced = orgPermissions
		.filter(isGrantable)
		.filter((permission) => !new RegExp(`['"\`]${permission}['"\`]`).test(code))
		.sort()

	expect(unreferenced).toEqual([...unenforcedGrantablePermissions].sort())
})
