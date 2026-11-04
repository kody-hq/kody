import {
	bytesToSnapshotString,
	snapshotStringToBytes,
} from '#universal/package-file-media.ts'
import { omitKodyIgnoredFiles } from '#worker/repo/kodyignore.ts'
import { sha256Hex } from './module-hashes.ts'
import type { PublishBuildFileEntry } from './types.ts'

/**
 * The file set a build outside the worker hashes and bundles, made the way
 * the server makes its published snapshot: blobs become snapshot strings
 * (latin1 for binaries, UTF-8 otherwise) and the source root's
 * `.kodyignore` drops files. Each file is hashed as the bytes its snapshot
 * string stores, which is how the server hashes its own snapshot.
 */
export async function preparePublishBuildSourceTree(input: {
	files: ReadonlyArray<{ path: string; bytes: Uint8Array }>
	sourceRoot: string
}) {
	const snapshot: Record<string, string> = {}
	for (const file of input.files) {
		snapshot[file.path] = bytesToSnapshotString(file.bytes, file.path)
	}
	const sourceFiles = omitKodyIgnoredFiles(snapshot, input.sourceRoot)
	const manifest: Array<PublishBuildFileEntry> = []
	for (const [path, content] of Object.entries(sourceFiles)) {
		const bytes = snapshotStringToBytes(content, path)
		manifest.push({
			path,
			size: bytes.byteLength,
			sha256: await sha256Hex(bytes),
		})
	}
	return { sourceFiles, manifest }
}
