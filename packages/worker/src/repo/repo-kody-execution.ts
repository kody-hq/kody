import type { RepoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import { normalizeRepoWorkspacePath } from './manifest.ts'
import type { RepoSessionTreeResult } from './types.ts'

export const repoCapabilitiesModuleTypecheckHarnessPath =
	'.__kody_repo_module_check__.ts'

export const repoBackedModuleEntrypointExportErrorMessage =
	'Repo-backed package export entrypoints and job entrypoints must default export a function so Kody can invoke them with execute semantics.'

const repoCapabilitiesSourceReadConcurrency = 8
const repoCapabilitiesSourceMaxFiles = 250
const repoCapabilitiesSourceMaxBytes = 2 * 1024 * 1024
const repoCapabilitiesImportExtensionPattern = /\.(?:[cm]?[jt]s|[jt]sx)$/

function stripTrailingSlashes(value: string) {
	return value.replace(/\/+$/, '')
}

function createRelativeImportSpecifier(path: string) {
	const normalizedPath = normalizeRepoWorkspacePath(path).replace(
		repoCapabilitiesImportExtensionPattern,
		'',
	)
	return JSON.stringify(`./${normalizedPath}`)
}

function toRelativeSourcePath(path: string, sourceRoot: string) {
	const normalizedPath = normalizeRepoWorkspacePath(path)
	const normalizedSourceRoot = stripTrailingSlashes(
		normalizeRepoWorkspacePath(sourceRoot),
	)
	if (!normalizedSourceRoot) return normalizedPath
	if (normalizedPath === normalizedSourceRoot) return ''
	if (normalizedPath.startsWith(`${normalizedSourceRoot}/`)) {
		return normalizedPath.slice(normalizedSourceRoot.length + 1)
	}
	return normalizedPath
}

function collectTreeFilePaths(node: RepoSessionTreeResult): Array<string> {
	if (node.type === 'file') {
		return node.path.trim() ? [node.path] : []
	}
	return (node.children ?? []).flatMap((child: RepoSessionTreeResult) =>
		collectTreeFilePaths(child),
	)
}

export function getRepoSourceRelativePath(path: string, sourceRoot: string) {
	return toRelativeSourcePath(path, sourceRoot)
}

export async function loadRepoSourceFilesFromSession(input: {
	sessionClient: Pick<RepoSessionRpc, 'readFile' | 'tree'>
	sessionId: string
	userId: string
	sourceRoot: string
}): Promise<Record<string, string>> {
	const tree = await input.sessionClient.tree({
		sessionId: input.sessionId,
		userId: input.userId,
		path: input.sourceRoot,
	})
	const filePaths = collectTreeFilePaths(tree)
	const files: Array<readonly [string, string]> = []
	const encoder = new TextEncoder()
	let nextIndex = 0
	let totalBytes = 0
	let limitError: string | null = null
	let shouldStop = false

	const readNextFile = async () => {
		while (!shouldStop) {
			const fileIndex = nextIndex
			nextIndex += 1
			if (fileIndex >= filePaths.length) return
			const path = filePaths[fileIndex]!
			const file = await input.sessionClient.readFile({
				sessionId: input.sessionId,
				userId: input.userId,
				path,
			})
			if (shouldStop || file.content == null) continue
			const relativePath = toRelativeSourcePath(path, input.sourceRoot)
			if (!relativePath) continue
			if (files.length >= repoCapabilitiesSourceMaxFiles) {
				limitError = `Repo-backed source root "${input.sourceRoot}" exceeded the ${repoCapabilitiesSourceMaxFiles}-file bundle limit.`
				shouldStop = true
				return
			}
			const fileBytes = encoder.encode(file.content).byteLength
			if (totalBytes + fileBytes > repoCapabilitiesSourceMaxBytes) {
				limitError = `Repo-backed source root "${input.sourceRoot}" exceeded the ${repoCapabilitiesSourceMaxBytes}-byte bundle limit.`
				shouldStop = true
				return
			}
			totalBytes += fileBytes
			files.push([relativePath, file.content] as const)
		}
	}

	await Promise.all(
		Array.from(
			{
				length: Math.max(
					1,
					Math.min(repoCapabilitiesSourceReadConcurrency, filePaths.length),
				),
			},
			() => readNextFile(),
		),
	)
	if (limitError) {
		throw new Error(limitError)
	}
	return Object.fromEntries(files)
}

export function createRepoCapabilitiesModuleTypecheckHarness(input: {
	entryPoints: ReadonlyArray<string>
}) {
	if (input.entryPoints.length === 0) {
		return `/// <reference path="./.__kody_repo_runtime__.d.ts" />
`
	}
	const imports = input.entryPoints
		.map(
			(entryPoint, index) =>
				`import userEntrypoint${index} from ${createRelativeImportSpecifier(entryPoint)};`,
		)
		.join('\n')
	const checks = input.entryPoints
		.map((_, index) => `__kodyTypecheckModule(userEntrypoint${index});`)
		.join('\n')
	return `/// <reference path="./.__kody_repo_runtime__.d.ts" />
${imports}

declare function __kodyTypecheckModule(
  fn: (params?: Record<string, unknown>) => Promise<unknown> | unknown,
): void;

${checks}
`
}

/**
 * Map harness line numbers (0-based) to the callable entry they typecheck.
 * Import lines and `__kodyTypecheckModule(...)` call lines both count so
 * diagnostics from a single language-service pass can be attributed the same
 * way the old per-target harness loop did.
 */
export function mapRepoCapabilitiesModuleTypecheckHarnessLines(input: {
	entryPoints: ReadonlyArray<string>
}) {
	const lineToEntryPoint = new Map<number, string>()
	if (input.entryPoints.length === 0) return lineToEntryPoint
	// Line 0 is the triple-slash reference.
	let line = 1
	for (const entryPoint of input.entryPoints) {
		lineToEntryPoint.set(line, entryPoint)
		line += 1
	}
	// blank line + declare function (3 lines) + blank line
	line += 5
	for (const entryPoint of input.entryPoints) {
		lineToEntryPoint.set(line, entryPoint)
		line += 1
	}
	return lineToEntryPoint
}
