/**
 * The saved packages Kody served to one execution-context run, kept on its
 * lease. Code on the machine cannot be trusted to say which package it is, so
 * attribution and package rules use this set, which only origin writes.
 */
export type ExecutionContextRunPackages = {
	/** Packages the run's code imports directly. */
	entries: Array<string>
	/** Entries plus everything they import. */
	all: Array<string>
}

/** A run that loads more packages than this keeps the first ones served. */
export const maxRunPackagesRecorded = 200

export function mergeRunPackages(
	current: ExecutionContextRunPackages | undefined,
	served: { entryPackageIds: Array<string>; packageIds: Array<string> },
): ExecutionContextRunPackages {
	const union = (left: Array<string>, right: Array<string>) =>
		[...new Set([...left, ...right])].slice(0, maxRunPackagesRecorded)
	const entries = union(current?.entries ?? [], served.entryPackageIds)
	return {
		entries,
		all: union(current?.all ?? [], [...entries, ...served.packageIds]),
	}
}
