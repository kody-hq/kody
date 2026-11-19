import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	bytesToSnapshotString,
	snapshotStringToBytes,
} from '#universal/package-file-media.ts'
import {
	buildExternalPublishSnapshotTooLargeMessage,
	externalPublishSnapshotMaxTotalBytes,
} from './external-publish-clone.ts'
import { createIsolatedArtifactRebuildRunner } from './isolated-artifact-rebuild.ts'
import { normalizeRepoWorkspacePath } from './manifest.ts'
import {
	isPackageCheckUploadId,
	packageCheckUploadKey,
} from './package-run-staging-keys.ts'
import {
	createPublishWorkTree,
	stagePublishWorkFiles,
	type PublishWorkTree,
} from './publish-work.ts'

export const packageCheckMaxFiles = 2_000

export {
	createPackageCheckUploadId,
	isPackageCheckUploadId,
	packageCheckUploadKey,
	packageRunResultKey,
} from './package-run-staging-keys.ts'

/** A tree the author must fix before any check can run. */
export class PackageCheckUploadError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PackageCheckUploadError'
	}
}

function normalizePackageCheckPath(path: string) {
	const key = normalizeRepoWorkspacePath(path).replace(/^(\.\/)+/, '')
	if (!key || key.split('/').includes('..')) {
		throw new PackageCheckUploadError(
			`File path ${JSON.stringify(path)} must be relative to the package root.`,
		)
	}
	return key
}

function decodeBinaryContent(path: string, base64: string) {
	let binary: string
	try {
		binary = atob(base64)
	} catch {
		throw new PackageCheckUploadError(
			`binary_contents[${JSON.stringify(path)}] is not valid base64.`,
		)
	}
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes
}

function readStringRecord(value: unknown, field: string) {
	if (value === undefined) return {}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new PackageCheckUploadError(
			`\`${field}\` must be an object of path to string.`,
		)
	}
	for (const [path, content] of Object.entries(value)) {
		if (typeof content !== 'string') {
			throw new PackageCheckUploadError(
				`\`${field}[${JSON.stringify(path)}]\` must be a string.`,
			)
		}
	}
	return value as Record<string, string>
}

function readManifestName(files: Record<string, string>): string | null {
	const content = files['package.json']
	if (typeof content !== 'string') return null
	try {
		const parsed = JSON.parse(content) as unknown
		if (parsed && typeof parsed === 'object' && 'name' in parsed) {
			const name = (parsed as { name?: unknown }).name
			return typeof name === 'string' && name.trim() ? name.trim() : null
		}
	} catch {
		// The manifest check reports the parse error.
	}
	return null
}

export type ParsedPackageCheckUpload = {
	tree: PublishWorkTree
	packageName: string | null
	manifestContent: string | null
	fileCount: number
	totalBytes: number
	/** Set when the tree is over the checked-out-tree cap a publish enforces. */
	tooLargeMessage: string | null
}

/**
 * The tree a git-push publish would clone, from an uploaded check body
 * (`{ files, binary_contents }`): paths normalized, binaries decoded into the
 * snapshot byte for byte, `.kodyignore` applied before anything is counted,
 * then the clone's caps.
 */
export function parsePackageCheckUpload(
	text: string,
): ParsedPackageCheckUpload {
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		throw new PackageCheckUploadError('The uploaded check body is not JSON.')
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new PackageCheckUploadError(
			'The uploaded check body must be an object with `files`.',
		)
	}
	const record = body as Record<string, unknown>
	const textFiles = readStringRecord(record['files'], 'files')
	const binaryContents = readStringRecord(
		record['binary_contents'],
		'binary_contents',
	)
	if (Object.keys(textFiles).length === 0) {
		throw new PackageCheckUploadError('Provide at least package.json.')
	}
	if (
		Object.keys(textFiles).length + Object.keys(binaryContents).length >
		packageCheckMaxFiles
	) {
		throw new PackageCheckUploadError(
			`At most ${packageCheckMaxFiles} files (the publish check limit).`,
		)
	}
	const files: Record<string, string> = Object.create(null)
	for (const [path, content] of Object.entries(textFiles)) {
		files[normalizePackageCheckPath(path)] = content
	}
	for (const [rawPath, base64] of Object.entries(binaryContents)) {
		const path = normalizePackageCheckPath(rawPath)
		if (path in files) {
			throw new PackageCheckUploadError(
				`File path ${JSON.stringify(path)} is in both files and binary_contents.`,
			)
		}
		files[path] = bytesToSnapshotString(decodeBinaryContent(path, base64), path)
	}
	const tree = createPublishWorkTree({ files, sourceRoot: '' })
	let totalBytes = 0
	for (const [path, content] of Object.entries(tree.files)) {
		totalBytes += snapshotStringToBytes(content, path).byteLength
	}
	const fileCount = Object.keys(tree.files).length
	return {
		tree,
		packageName: readManifestName(files),
		manifestContent:
			typeof files['package.json'] === 'string' ? files['package.json'] : null,
		fileCount,
		totalBytes,
		tooLargeMessage:
			totalBytes > externalPublishSnapshotMaxTotalBytes
				? buildExternalPublishSnapshotTooLargeMessage({
						totalBytes,
						limitBytes: externalPublishSnapshotMaxTotalBytes,
						fileCount,
					})
				: null,
	}
}

export type PackageCheckPrepareRequest = {
	userId: OwnerId
	uploadId: string
}

export type PackageCheckPrepareResult =
	| { ok: false; message: string; packageName: string | null }
	| {
			ok: true
			packageName: string | null
			manifestContent: string | null
			fileCount: number
			totalBytes: number
			/** Staged for the shared publish work runner (checks). */
			stagingKey: string
			/** Staged for the artifact build check; null without rebuild bindings. */
			artifactStagingKey: string | null
	  }

/**
 * Body of the `RepoSession.runIsolatedPackageCheckPrepare` RPC: read the
 * uploaded body from R2 in this throwaway isolate, build the publish tree, and
 * stage it for the phases that follow. Only this isolate ever parses the body.
 */
export async function prepareStagedPackageCheckUpload(input: {
	env: Env
	request: PackageCheckPrepareRequest
}): Promise<PackageCheckPrepareResult> {
	const { userId, uploadId } = input.request
	if (!isPackageCheckUploadId(uploadId)) {
		return { ok: false, message: 'upload_id is not valid.', packageName: null }
	}
	const object = await input.env.REPO_SESSION_BLOBS.get(
		packageCheckUploadKey(userId, uploadId),
	)
	if (!object) {
		return {
			ok: false,
			message:
				'The uploaded package tree expired or is missing; run the check again.',
			packageName: null,
		}
	}
	let parsed: ParsedPackageCheckUpload
	try {
		parsed = parsePackageCheckUpload(await object.text())
	} catch (error) {
		if (error instanceof PackageCheckUploadError) {
			return { ok: false, message: error.message, packageName: null }
		}
		throw error
	}
	if (parsed.tooLargeMessage) {
		return {
			ok: false,
			message: parsed.tooLargeMessage,
			packageName: parsed.packageName,
		}
	}
	const stagingKey = await stagePublishWorkFiles({
		kv: input.env.BUNDLE_ARTIFACTS_KV,
		userId,
		tree: parsed.tree,
	})
	const artifactRunner = createIsolatedArtifactRebuildRunner(input.env)
	const artifactStagingKey = artifactRunner
		? await artifactRunner.stage({ userId, sourceFiles: parsed.tree.files })
		: null
	return {
		ok: true,
		packageName: parsed.packageName,
		manifestContent: parsed.manifestContent,
		fileCount: parsed.fileCount,
		totalBytes: parsed.totalBytes,
		stagingKey,
		artifactStagingKey,
	}
}
