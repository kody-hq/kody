#!/usr/bin/env node
/**
 * Detached entry for best-effort hosted skill refresh. Spawned by the CLI so
 * the parent process can exit without waiting on network I/O.
 */
import { refreshInstalledSkills } from './skill.js'

function readOrigin(argv: Array<string>): string | undefined {
	const index = argv.indexOf('--origin')
	if (index < 0) return undefined
	const value = argv[index + 1]
	return typeof value === 'string' && value.trim() !== ''
		? value.trim()
		: undefined
}

await refreshInstalledSkills({
	origin: readOrigin(process.argv.slice(2)),
}).catch(() => {
	// Best-effort: never fail the parent command.
})
