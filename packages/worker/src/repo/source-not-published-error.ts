/** The source has commits on Artifacts but none was ever published. */
export class PackageSourceNotPublishedError extends Error {
	readonly sourceId: string
	constructor(sourceId: string) {
		super(`Source "${sourceId}" has no published commit.`)
		this.name = 'PackageSourceNotPublishedError'
		this.sourceId = sourceId
	}
}

export function isPackageSourceNotPublishedError(
	error: unknown,
): error is PackageSourceNotPublishedError {
	return error instanceof PackageSourceNotPublishedError
}
