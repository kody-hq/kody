import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import { runAuthoringPublishChecksOnFiles } from '#worker/repo/authoring-publish-checks.ts'
import {
	deferredBundleCheckMessage,
	repoCheckKinds,
} from '#worker/repo/checks.ts'
import {
	knownUnmappableCredentials,
	loadOnePackageUnmappableCredentials,
	unmappableCredentialOwnerNotice,
} from '#worker/credentials/package-unmappable-credentials.ts'
import { runAuthoringChecksInIsolate } from '#worker/repo/isolated-check-phases.ts'
import {
	createRepoChecksError,
	RepoChecksPlatformError,
} from '#worker/repo/repo-checks-failed-error.ts'
import { normalizeRepoWorkspacePath } from '#worker/repo/manifest.ts'
import {
	bytesToSnapshotString,
	snapshotStringToBytes,
} from '#universal/package-file-media.ts'
import {
	buildExternalPublishSnapshotTooLargeMessage,
	externalPublishSnapshotMaxTotalBytes,
} from '#worker/repo/external-publish-clone.ts'
import { createIsolatedArtifactRebuildRunner } from '#worker/repo/isolated-artifact-rebuild.ts'
import {
	createSourceRootKodyIgnoreMatcher,
	kodyIgnoreFilePath,
} from '#worker/repo/kodyignore.ts'
import { runPackageCheckArtifactBuild } from '#worker/repo/package-check-artifact-build.ts'
import { createPublishWorkTree } from '#worker/repo/publish-work.ts'
import { resolveOwnedPackageSource } from './resolve-package-source.ts'

export const packageCheckMaxFiles = 2_000

const checkResultSchema = z.object({
	kind: z.enum(repoCheckKinds),
	ok: z.boolean(),
	message: z.string(),
})

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

/**
 * The tree a git-push publish would clone: `.kodyignore` applied before
 * anything is counted, then the clone's checked-out-tree cap.
 */
function preparePublishSnapshot(input: {
	files: Record<string, string>
	binaryFileSizes: Record<string, number>
}) {
	const tree = createPublishWorkTree({ files: input.files, sourceRoot: '' })
	const ignoredPath = createSourceRootKodyIgnoreMatcher({
		ignoreFileContent: input.files[kodyIgnoreFilePath()] ?? null,
	})
	const binaryFileSizes = Object.fromEntries(
		Object.entries(input.binaryFileSizes).filter(
			([path]) => ignoredPath?.(path) == null,
		),
	)
	let totalBytes = 0
	for (const [path, content] of Object.entries(tree.files)) {
		totalBytes += snapshotStringToBytes(content, path).byteLength
	}
	for (const size of Object.values(binaryFileSizes)) totalBytes += size
	const fileCount =
		Object.keys(tree.files).length + Object.keys(binaryFileSizes).length
	const tooLargeMessage =
		totalBytes > externalPublishSnapshotMaxTotalBytes
			? buildExternalPublishSnapshotTooLargeMessage({
					totalBytes,
					limitBytes: externalPublishSnapshotMaxTotalBytes,
					fileCount,
				})
			: null
	return { tree, binaryFileSizes, tooLargeMessage }
}

function normalizePackageCheckPath(path: string) {
	const key = normalizeRepoWorkspacePath(path).replace(/^(\.\/)+/, '')
	if (!key || key.split('/').includes('..')) {
		throw new McpCallerError(
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
		throw new McpCallerError(
			`binary_contents[${JSON.stringify(path)}] is not valid base64.`,
		)
	}
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes
}

function normalizePackageCheckFiles<Value>(
	files: Record<string, Value>,
): Record<string, Value> {
	const normalized: Record<string, Value> = Object.create(null)
	for (const [path, value] of Object.entries(files)) {
		normalized[normalizePackageCheckPath(path)] = value
	}
	return normalized
}

export const packageCheckCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageCheck',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			'Dry-run the publish checks on a package tree without saving, pushing, or publishing anything. Pass `files` (paths relative to the package root, where package.json lives, mapped to UTF-8 contents) and, for binary files such as PNG app assets, `binary_files` (path mapped to byte size; contents are not uploaded). Runs the same checks, with the same options, that `kody package publish`, git-push publish, and Promote run before they publish or hand out an approval link: manifest, credential stamp gate, docs, skills, dependencies, bundle, typecheck, and lint. `ok: false` means publish would refuse this tree with the same messages in `checks`. `kody dev check` calls this. List every binary file in `binary_files`: publish counts them toward size limits and toward `kody.app.assets`, so a binary-only assets directory left out of the request fails the assets check.',
		keywords: [
			'package',
			'check',
			'publish',
			'dry run',
			'validate',
			'lint',
			'typecheck',
			'credentials',
			'stamp',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z
			.object({
				files: z
					.record(z.string(), z.string())
					.refine((files) => Object.keys(files).length > 0, {
						message: 'Provide at least package.json.',
					})
					.refine(
						(files) => Object.keys(files).length <= packageCheckMaxFiles,
						{
							message: `At most ${packageCheckMaxFiles} files (the publish check limit).`,
						},
					)
					.describe(
						'Package tree: path relative to the package root (for example `package.json`, `src/index.ts`) mapped to UTF-8 file contents.',
					),
				binary_files: z
					.record(z.string(), z.number().int().nonnegative())
					.optional()
					.describe(
						'Binary files (not UTF-8 text, for example `icons/icon-192.png`): path relative to the package root mapped to its size in bytes. Only for callers that cannot send `binary_contents`: these count toward size limits and `kody.app.assets`, but their contents are not checked.',
					),
				binary_contents: z
					.record(z.string(), z.string())
					.optional()
					.describe(
						'Binary files mapped to their base64 contents. They join the checked tree byte for byte, exactly as a git-push publish snapshots them. A path here may also be listed in `binary_files` (older servers read only that); the contents win.',
					),
			})
			.refine(
				(input) =>
					Object.keys(input.files).length +
						Object.keys(input.binary_files ?? {}).filter(
							(path) => !Object.hasOwn(input.binary_contents ?? {}, path),
						).length +
						Object.keys(input.binary_contents ?? {}).length <=
					packageCheckMaxFiles,
				{
					message: `At most ${packageCheckMaxFiles} files (the publish check limit), counting binary_files.`,
				},
			),
		outputSchema: z.object({
			ok: z.boolean().describe('True when publish checks pass for this tree.'),
			package_name: z
				.string()
				.nullable()
				.describe('`name` from package.json, when it parsed.'),
			checks: z
				.array(checkResultSchema)
				.describe(
					'Every check that ran, in publish order. Failed checks carry the exact publish message.',
				),
			notices: z
				.array(z.string())
				.describe(
					'Notices that do not fail the check, e.g. the existing package has unmappable credentials, so changes and publishes are owner-only unless a grant allows them.',
				),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const files = normalizePackageCheckFiles(args.files)
			const binaryFileSizes = normalizePackageCheckFiles(
				args.binary_files ?? {},
			)
			for (const path of Object.keys(binaryFileSizes)) {
				if (path in files) {
					throw new McpCallerError(
						`File path ${JSON.stringify(path)} is in both files and binary_files.`,
					)
				}
			}
			for (const [path, base64] of Object.entries(
				normalizePackageCheckFiles(args.binary_contents ?? {}),
			)) {
				if (path in files) {
					throw new McpCallerError(
						`File path ${JSON.stringify(path)} is in both files and binary_contents.`,
					)
				}
				files[path] = bytesToSnapshotString(
					decodeBinaryContent(path, base64),
					path,
				)
				delete binaryFileSizes[path]
			}
			const packageName = readManifestName(files)
			// An existing package lets the checks compare credential needs with
			// its published version, exactly as a publish of it would.
			let sourceId: string | undefined
			let existingPackage: { id: string; name: string } | undefined
			if (packageName) {
				try {
					const existing = await resolveOwnedPackageSource({
						db: ctx.env.APP_DB,
						userId: owner.ownerUserId,
						ownerScope: owner.ownerScope,
						args: { kody_id: getPackageNameLeaf(packageName) },
					})
					sourceId = existing.source.id
					existingPackage = { id: existing.packageId, name: existing.name }
				} catch {
					sourceId = undefined
				}
			}
			const snapshot = preparePublishSnapshot({ files, binaryFileSizes })
			if (snapshot.tooLargeMessage) {
				return {
					ok: false,
					notices: [],
					package_name: packageName,
					checks: [
						{
							kind: 'manifest' as const,
							ok: false,
							message: snapshot.tooLargeMessage,
						},
					],
				}
			}
			// Git-push publish defers bundling to the artifact rebuild; do the
			// same, then build the rebuild's targets below. Envs without the
			// rebuild bindings keep the full up-front bundle validation.
			const artifactRunner = createIsolatedArtifactRebuildRunner(ctx.env)
			const checkInput = {
				files: snapshot.tree.files,
				...(Object.keys(snapshot.binaryFileSizes).length > 0
					? { binaryFileSizes: snapshot.binaryFileSizes }
					: {}),
				...(snapshot.tree.kodyIgnoredDeclarationFiles.length > 0
					? {
							kodyIgnoredDeclarationFiles:
								snapshot.tree.kodyIgnoredDeclarationFiles,
						}
					: {}),
				...(artifactRunner ? { deferBundleCheckToRebuild: true } : {}),
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: owner.ownerUserId,
				expectedPackageScope: owner.ownerScope,
				...(sourceId ? { sourceId } : {}),
			}
			// Run in a throwaway check isolate, like publish does, never in the
			// shared request isolate: a large tree there can exceed the isolate
			// memory limit and kill the request with no answer at all.
			const checks =
				(await runAuthoringChecksInIsolate(checkInput)) ??
				(await runAuthoringPublishChecksOnFiles(checkInput))
			if (checks.ok && artifactRunner) {
				const deferredIndex = checks.results.findIndex(
					(result) =>
						result.kind === 'bundle' &&
						result.message === deferredBundleCheckMessage,
				)
				if (deferredIndex !== -1) {
					const built = await runPackageCheckArtifactBuild({
						runner: artifactRunner,
						files: snapshot.tree.files,
						userId: owner.ownerUserId,
						baseUrl: ctx.callerContext.baseUrl,
						expectedPackageScope: owner.ownerScope,
						...(existingPackage ? { rootPackageId: existingPackage.id } : {}),
					})
					checks.results[deferredIndex] = built
					if (!built.ok) {
						Object.assign(checks, { ok: false })
					}
				}
			}
			// Kody infrastructure failures are not package diagnostics: throw so
			// they reach Sentry instead of reading as checks the author must fix.
			const checksError = checks.ok
				? null
				: createRepoChecksError(checks.results)
			if (checksError instanceof RepoChecksPlatformError) throw checksError
			const unmappable = existingPackage
				? knownUnmappableCredentials(
						await loadOnePackageUnmappableCredentials({
							env: ctx.env,
							orgId: owner.ownerUserId,
							packageId: existingPackage.id,
							request: ctx.callerContext.request,
						}),
					)
				: []
			const notices =
				existingPackage && unmappable.length > 0
					? [
							unmappableCredentialOwnerNotice({
								packageLabel: `Package "${existingPackage.name}"`,
								credentials: unmappable,
							}),
						]
					: []
			return {
				ok: checks.ok,
				notices,
				package_name: packageName,
				checks: checks.results.map((result) => ({
					kind: result.kind,
					ok: result.ok,
					message: result.message,
				})),
			}
		},
	},
)
