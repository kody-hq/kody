/**
 * Print read-only SQL (and optionally run it against local D1) for saved
 * packages whose name leaf collides with package-app host reserved paths.
 *
 * Does not rename or mutate rows. Usage:
 *   npx tsx tools/package-app-reserved-leaf-audit.ts
 *   npx tsx tools/package-app-reserved-leaf-audit.ts --local
 */
import {
	listPackageAppHostReservedPackageLeaves,
	packageAppHostReservedPackageLeafAuditSql,
} from '../packages/shared/src/package-app-host-paths.ts'
import { resolveLocalD1PersistPath } from './local-d1-persist.ts'
import { isExecutedDirectly } from './node-runtime.ts'
import {
	executeWranglerD1,
	type WranglerD1Target,
} from './wrangler-d1-execute.ts'

function main() {
	const sql = packageAppHostReservedPackageLeafAuditSql()

	console.log('# Reserved package-app host leaves')
	console.log(listPackageAppHostReservedPackageLeaves().join(', '))
	console.log('')
	console.log('# Audit SQL (read-only)')
	console.log(sql)

	if (!process.argv.includes('--local')) {
		return
	}

	const target: WranglerD1Target = {
		mode: '--local',
		config: 'packages/worker/wrangler.jsonc',
		persistTo: resolveLocalD1PersistPath(),
		cwd: process.cwd(),
	}

	try {
		const rows = executeWranglerD1({
			...target,
			binding: 'APP_DB',
			sql,
		})
		console.log('')
		console.log(`# Local D1 matches: ${rows.length}`)
		if (rows.length === 0) {
			console.log('(none)')
		} else {
			console.log(JSON.stringify(rows, null, 2))
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(`# Local D1 query failed: ${message}`)
		process.exitCode = 1
	}
}

if (isExecutedDirectly(import.meta.url)) {
	main()
}
