import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function resolveLocalBinary(binaryName: string) {
	const localBinaryPath = path.join(
		process.cwd(),
		'node_modules',
		'.bin',
		process.platform === 'win32' ? `${binaryName}.cmd` : binaryName,
	)

	return existsSync(localBinaryPath) ? localBinaryPath : binaryName
}

export function resolveNpmCommand() {
	return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** Default Cloud Agent / CI typecheck heap. Node's ~2GB default OOMs here. */
export const nodeHeapFloorMb = 8192

const maxOldSpaceSizePattern = /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s)/

/**
 * Ensure `NODE_OPTIONS` includes a heap floor. Leaves an explicit
 * `--max-old-space-size` or `--max_old_space_size` alone so callers can
 * raise or lower it.
 */
export function envWithNodeHeapFloor(
	env: NodeJS.ProcessEnv = process.env,
	floorMb = nodeHeapFloorMb,
): NodeJS.ProcessEnv {
	const current = env.NODE_OPTIONS ?? ''
	if (maxOldSpaceSizePattern.test(current)) return env
	const next = [current.trim(), `--max-old-space-size=${floorMb}`]
		.filter((part) => part.length > 0)
		.join(' ')
	return { ...env, NODE_OPTIONS: next }
}

export function isExecutedDirectly(importMetaUrl: string) {
	const entryPoint = process.argv[1]
	if (!entryPoint) {
		return false
	}

	return pathToFileURL(path.resolve(entryPoint)).href === importMetaUrl
}
