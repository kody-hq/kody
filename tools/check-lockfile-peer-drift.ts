import { readFile } from 'node:fs/promises'
import semver from 'semver'
import { isExecutedDirectly } from './node-runtime.ts'

const defaultPackageLockPath = 'package-lock.json'

type PackageLock = {
	packages?: Record<string, LockPackage>
}

type LockPackage = {
	version?: string
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

type LockfilePeerDrift = {
	name: string
	lockedVersion: string
	directRanges: Array<string>
	peerRange: string
	from: string
}

/**
 * `npm install` rewrites package-lock.json when a hoisted direct dependency
 * sits inside every declared range but outside a peer range those ranges can
 * still reach. Optional peers count: wrangler marks `@cloudflare/workers-types`
 * optional and npm still bumps it. A peer range that does not intersect the
 * declared ranges (vite 8 vs a vite 7 peer) cannot be fixed by moving the
 * direct dependency, so npm leaves the lockfile alone.
 */
export function findLockfilePeerDrift(
	lock: PackageLock,
): Array<LockfilePeerDrift> {
	const packages = lock.packages ?? {}
	const directRangesByName = new Map<string, Set<string>>()
	for (const [packagePath, meta] of Object.entries(packages)) {
		if (packagePath !== '' && packagePath.includes('node_modules')) continue
		for (const [name, range] of Object.entries(declaredRanges(meta))) {
			const ranges = directRangesByName.get(name) ?? new Set<string>()
			ranges.add(range)
			directRangesByName.set(name, ranges)
		}
	}

	const drifts: Array<LockfilePeerDrift> = []
	for (const [name, rangeSet] of directRangesByName) {
		const lockedVersion = packages[`node_modules/${name}`]?.version
		if (!lockedVersion) continue
		const directRanges = [...rangeSet].toSorted()
		for (const [packagePath, meta] of Object.entries(packages)) {
			const peerRange = meta.peerDependencies?.[name]
			if (!peerRange) continue
			if (
				semver.satisfies(lockedVersion, peerRange, {
					includePrerelease: true,
				})
			) {
				continue
			}
			if (!directRangesAllowPeer(directRanges, peerRange)) continue
			drifts.push({
				name,
				lockedVersion,
				directRanges,
				peerRange,
				from: packagePath === '' ? '<root>' : packagePath,
			})
		}
	}

	return drifts.toSorted((left, right) =>
		driftKey(left).localeCompare(driftKey(right)),
	)
}

type WorkspaceDuplicate = {
	name: string
	version: string
	installPaths: Array<string>
}

const workspaceNestedPackagePattern =
	/^(?<workspace>(?:[^/]+\/)*?[^/]+)\/node_modules\/(?<name>(?:@[^/]+\/)?[^/]+)$/

/**
 * Two workspaces that each nest the same package version with no root copy
 * ship that package twice in any bundle that imports both workspaces. npm
 * keeps such a lockfile as-is, so `npm install` never repairs it on its own.
 */
export function findWorkspaceDuplicates(
	lock: PackageLock,
): Array<WorkspaceDuplicate> {
	const packages = lock.packages ?? {}
	const installPathsByPackage = new Map<string, Array<string>>()
	for (const [packagePath, meta] of Object.entries(packages)) {
		const match = workspaceNestedPackagePattern.exec(packagePath)
		const workspace = match?.groups?.workspace
		const name = match?.groups?.name
		if (!workspace || !name || !meta.version) continue
		if (workspace.includes('node_modules')) continue
		if (packages[`node_modules/${name}`]) continue
		const key = `${name}@${meta.version}`
		const installPaths = installPathsByPackage.get(key) ?? []
		installPaths.push(packagePath)
		installPathsByPackage.set(key, installPaths)
	}

	const duplicates: Array<WorkspaceDuplicate> = []
	for (const installPaths of installPathsByPackage.values()) {
		if (installPaths.length < 2) continue
		const [firstPath] = installPaths
		if (!firstPath) continue
		const name = workspaceNestedPackagePattern.exec(firstPath)?.groups?.name
		const version = packages[firstPath]?.version
		if (!name || !version) continue
		duplicates.push({ name, version, installPaths: installPaths.toSorted() })
	}
	return duplicates.toSorted((left, right) =>
		left.name.localeCompare(right.name),
	)
}

function formatWorkspaceDuplicate(duplicate: WorkspaceDuplicate): string {
	return `${duplicate.name}@${duplicate.version} is installed separately in ${duplicate.installPaths.join(', ')} with no root copy, so bundles ship it more than once. Hoist one copy to node_modules/${duplicate.name} in package-lock.json and run npm install.`
}

function formatLockfilePeerDrift(drift: LockfilePeerDrift): string {
	return `${drift.name}@${drift.lockedVersion} is inside ${drift.directRanges.join(', ')} but outside peer ${drift.peerRange} from ${drift.from}. npm install rewrites package-lock.json to satisfy that peer. Run npm install and commit the lockfile.`
}

export async function checkLockfilePeerDrift(
	packageLockPath: string = defaultPackageLockPath,
): Promise<Array<string>> {
	const lock = JSON.parse(
		await readFile(packageLockPath, 'utf8'),
	) as PackageLock
	return [
		...findLockfilePeerDrift(lock).map(formatLockfilePeerDrift),
		...findWorkspaceDuplicates(lock).map(formatWorkspaceDuplicate),
	]
}

function declaredRanges(pkg: LockPackage | undefined): Record<string, string> {
	return {
		...pkg?.dependencies,
		...pkg?.devDependencies,
		...pkg?.optionalDependencies,
	}
}

function directRangesAllowPeer(
	directRanges: Array<string>,
	peerRange: string,
): boolean {
	return directRanges.every((range) => {
		try {
			return semver.intersects(range, peerRange, { includePrerelease: true })
		} catch {
			return false
		}
	})
}

function driftKey(drift: LockfilePeerDrift): string {
	return `${drift.name}\0${drift.from}\0${drift.peerRange}`
}

if (isExecutedDirectly(import.meta.url)) {
	const errors = await checkLockfilePeerDrift()
	if (errors.length > 0) {
		for (const error of errors) {
			console.error(error)
		}
		process.exitCode = 1
	}
}
