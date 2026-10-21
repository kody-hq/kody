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
import { repoCheckKinds } from '#worker/repo/checks.ts'
import { normalizeRepoWorkspacePath } from '#worker/repo/manifest.ts'
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

function normalizePackageCheckFiles(
	files: Record<string, string>,
): Record<string, string> {
	const normalized: Record<string, string> = {}
	for (const [path, content] of Object.entries(files)) {
		const key = normalizeRepoWorkspacePath(path).replace(/^(\.\/)+/, '')
		if (!key || key.split('/').includes('..')) {
			throw new McpCallerError(
				`File path ${JSON.stringify(path)} must be relative to the package root.`,
			)
		}
		normalized[key] = content
	}
	return normalized
}

export const packageCheckCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageCheck',
		orgPermission: 'package:read',
		description:
			'Dry-run the publish checks on a package tree without saving, pushing, or publishing anything. Pass `files` (paths relative to the package root, where package.json lives, mapped to UTF-8 contents). Runs the same checks, with the same options, that `kody package publish`, git-push publish, and Promote run before they publish or hand out an approval link: manifest, credential stamp gate, docs, skills, dependencies, bundle, typecheck, and lint. `ok: false` means publish would refuse this tree with the same messages in `checks`. `kody dev check` calls this. Binary files can be left out; they only count toward size limits.',
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
		inputSchema: z.object({
			files: z
				.record(z.string(), z.string())
				.refine((files) => Object.keys(files).length > 0, {
					message: 'Provide at least package.json.',
				})
				.refine((files) => Object.keys(files).length <= packageCheckMaxFiles, {
					message: `At most ${packageCheckMaxFiles} files (the publish check limit).`,
				})
				.describe(
					'Package tree: path relative to the package root (for example `package.json`, `src/index.ts`) mapped to UTF-8 file contents.',
				),
		}),
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
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request: requireMcpRequest(ctx.callerContext),
			})
			const files = normalizePackageCheckFiles(args.files)
			const packageName = readManifestName(files)
			// An existing package lets the checks compare credential needs with
			// its published version, exactly as a publish of it would.
			let sourceId: string | undefined
			if (packageName) {
				try {
					const existing = await resolveOwnedPackageSource({
						db: ctx.env.APP_DB,
						userId: owner.ownerUserId,
						ownerScope: owner.ownerScope,
						args: { kody_id: getPackageNameLeaf(packageName) },
					})
					sourceId = existing.source.id
				} catch {
					sourceId = undefined
				}
			}
			const checks = await runAuthoringPublishChecksOnFiles({
				files,
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: owner.ownerUserId,
				expectedPackageScope: owner.ownerScope,
				...(sourceId ? { sourceId } : {}),
			})
			return {
				ok: checks.ok,
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
