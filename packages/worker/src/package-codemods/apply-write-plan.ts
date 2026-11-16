import { shouldStoreArtifactBlobAsLatin1 } from '#universal/package-file-media.ts'

export class CodemodApplyWritePlanError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'CodemodApplyWritePlanError'
	}
}

/**
 * Source snapshots hold every file as a string. Text is UTF-8, but media,
 * known binary extensions and any blob with a NUL byte are byte-for-byte
 * (latin1) strings. Repo session write edits encode their content as UTF-8,
 * so writing such a string back turns every byte >= 0x80 into two bytes.
 */
export function isBinarySnapshotFile(path: string, content: string) {
	return content.includes('\0') || shouldStoreArtifactBlobAsLatin1(path)
}

/**
 * The paths an apply or revert may write: only files whose content differs
 * between the two trees. Fails closed when the difference touches a file that
 * is not UTF-8 text, removes a file, or does not match what the codemod
 * reported, so a publish never rewrites a file the codemod did not mean to
 * change.
 */
export function planCodemodApplyWrites(input: {
	before: Record<string, string>
	after: Record<string, string>
	/** When set, the differing paths must be exactly these. */
	expectedChangedPaths?: ReadonlyArray<string>
}): Array<string> {
	const removed = Object.keys(input.before).filter(
		(path) => !Object.hasOwn(input.after, path),
	)
	if (removed.length > 0) {
		throw new CodemodApplyWritePlanError(
			`Codemod apply cannot remove files (${removed.slice(0, 5).join(', ')}).`,
		)
	}
	const writes = Object.keys(input.after)
		.filter((path) => input.before[path] !== input.after[path])
		.sort()
	const binary = writes.filter(
		(path) =>
			isBinarySnapshotFile(path, input.after[path]!) ||
			(Object.hasOwn(input.before, path) &&
				isBinarySnapshotFile(path, input.before[path]!)),
	)
	if (binary.length > 0) {
		throw new CodemodApplyWritePlanError(
			`Codemod apply refuses to write files that are not UTF-8 text (${binary.slice(0, 5).join(', ')}).`,
		)
	}
	if (input.expectedChangedPaths) {
		const expected = new Set(input.expectedChangedPaths)
		const unexpected = writes.filter((path) => !expected.has(path))
		const written = new Set(writes)
		const missing = [...expected].filter((path) => !written.has(path))
		if (unexpected.length > 0 || missing.length > 0) {
			throw new CodemodApplyWritePlanError(
				`Codemod apply would write files that do not match what the codemod reported as changed (${[...unexpected, ...missing].slice(0, 5).join(', ')}).`,
			)
		}
	}
	return writes
}
