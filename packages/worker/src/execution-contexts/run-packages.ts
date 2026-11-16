/**
 * The saved packages Kody served to one execution-context run, kept on its
 * lease. Code on the machine cannot be trusted to say which package it is, so
 * attribution and package rules use this set, which only origin writes.
 */
export type ExecutionContextRunPackages = {
	/** Packages the run's code imports directly. */
	entries: Array<string>
	/** Entries plus everything they import. Always contains every entry. */
	all: Array<string>
	/** The run loaded more packages than are recorded, so the set is incomplete. */
	truncated?: true
}

/** A run that loads more packages than this is marked `truncated`. */
export const maxRunPackagesRecorded = 200

export function mergeRunPackages(
	current: ExecutionContextRunPackages | undefined,
	served: { entryPackageIds: Array<string>; packageIds: Array<string> },
): ExecutionContextRunPackages {
	const allEntries = [
		...new Set([...(current?.entries ?? []), ...served.entryPackageIds]),
	]
	const entries = allEntries.slice(0, maxRunPackagesRecorded)
	// Entries first, so the cap never drops an entry from `all`.
	const everything = [
		...new Set([...entries, ...(current?.all ?? []), ...served.packageIds]),
	]
	const truncated =
		current?.truncated === true ||
		allEntries.length > maxRunPackagesRecorded ||
		everything.length > maxRunPackagesRecorded
	return {
		entries,
		all: everything.slice(0, maxRunPackagesRecorded),
		...(truncated ? { truncated: true as const } : {}),
	}
}
