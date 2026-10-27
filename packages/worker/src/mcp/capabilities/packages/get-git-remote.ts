import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	AuthorizationError,
	authorize,
	authorizePackageCreate,
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	gitAuthorIdentityFromUser,
	gitAuthorIdentitySchema,
	gitAuthorSetupCommands,
	shellQuote,
} from '#worker/identity/git-author-identity.ts'
import {
	normalizePackageNameInput,
	packageIdLookupDescription,
	packageKodyIdOptionalInput,
	packageNameLookupDescription,
} from '#worker/package-registry/package-name.ts'
import { resolvePackageOwnerContext } from '#worker/package-registry/package-owner.ts'
import { resolveSavedPackageRef } from '#worker/package-registry/repo.ts'
import {
	KODY_DESCRIPTION_MAX_LENGTH,
	kodyDescriptionTooLongMessage,
} from '#worker/package-registry/types.ts'
import {
	buildAuthenticatedArtifactsRemote,
	parseArtifactTokenSecret,
} from '#worker/repo/artifacts.ts'
import { markEntitySourcePendingExternalReconcile } from '#worker/repo/entity-sources.ts'
import {
	enhanceGitRemoteReadDenial,
	enhanceGitRemoteWriteDenial,
	pickGitRemoteAccessScope,
} from '#worker/repo/git-remote-scope.ts'
import {
	assertPublishedPackageSourceRepoHead,
	assertRestorablePackageSourceSnapshot,
} from '#worker/repo/source-safety-policy.ts'
import { createStubSavedPackage } from './create-stub-package.ts'
import { resolveOwnedPackageSource } from './resolve-package-source.ts'

const getGitRemoteInputSchema = z.object({
	package_id: z.string().min(1).optional().describe(packageIdLookupDescription),
	name: z.string().min(1).optional().describe(packageNameLookupDescription),
	kody_id: packageKodyIdOptionalInput(),
	create: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			'Set true with the new `@scope/leaf` name (or the name leaf) to register a new stub saved package (private, minimal scaffold) when none exists yet, then mint its remote in the same call. Existing packages are reused as-is. Prefer the scoped name for existing packages; use `package_id` only when the name is not known.',
		),
	description: z
		.string()
		.min(1)
		.max(KODY_DESCRIPTION_MAX_LENGTH, kodyDescriptionTooLongMessage())
		.optional()
		.describe(
			`Package description used when \`create: true\` registers a new stub package. At most ${KODY_DESCRIPTION_MAX_LENGTH} characters (short public tagline). Ignored for existing packages.`,
		),
	scope: z
		.enum(['read', 'write'])
		.optional()
		.describe(
			"Access scope for the minted Artifacts token. When omitted, defaults to write if you have write access to the package, otherwise read. Explicit scope is honored; requesting write without write access is denied. A read remote rejects push with: this remote is read-only; request scope: 'write'.",
		),
	ttl_seconds: z.number().int().min(60).max(86_400).default(14_400),
})

const outputSchema = z.toJSONSchema(
	z.object({
		package_id: z.string(),
		kody_id: z.string().describe('Package name leaf (same value as `slug`).'),
		slug: z.string().describe('Package name leaf (same value as `kody_id`).'),
		created: z
			.boolean()
			.describe(
				'True when this call registered a new stub saved package before minting the remote.',
			),
		remote: z.string(),
		authenticated_remote: z.string(),
		git_extra_header: z.string(),
		scope: z.enum(['read', 'write']),
		expires_at: z.string(),
		git_author: gitAuthorIdentitySchema,
		setup_commands: z.array(z.string()),
	}),
) as Record<string, unknown>

export const getGitRemoteCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'packageGetGitRemote',
		orgPermission: ['package:read', 'package:create'],
		description:
			"Start or continue the git lane for saved packages: mint a short-lived Cloudflare Artifacts git remote so coding agents with local filesystem/git access can clone into a temporary directory. When scope is omitted, defaults to write if you have write access to the package, otherwise read. Pass scope explicitly to force read or write; requesting write without write access is denied with guidance (use scope: 'read', ask an Owner for a grant, or communityFork a public package). A read remote rejects push with: this remote is read-only; request scope: 'write'. Pass `create: true` with a new `@scope/leaf` name (or the name leaf) to register a stub saved package and mint its remote in one call, so new packages can be authored via clone-edit-push instead of packageSave file blobs. Prefer the scoped name for existing packages; use `package_id` only when the name is not known. The result includes `git_author` (signed-in Kody account email and display name) and `setup_commands` that set local `user.email` / `user.name` to that identity — never invent a git email. Write access verifies the current package source has a restorable backup snapshot before clone/edit/publish. Individual files may be at most 10 MiB (10,485,760 stored bytes; UTF-8 for text, raw for binary): publish rejects anything larger with external-hosting guidance (commit a link or pointer instead), and the Artifacts remote itself fails pushes above ~32 MiB of pack content with a raw HTTP 413.",
		keywords: [
			'package',
			'create',
			'new',
			'scaffold',
			'git',
			'remote',
			'artifacts',
			'clone',
			'push',
			'local clone',
			'temporary directory',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: getGitRemoteInputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const request = requireMcpRequest(ctx.callerContext)
			const authorizeCtx = {
				env: ctx.env,
				request,
			}
			const gitAuthor = gitAuthorIdentityFromUser(user)
			const owner = await resolvePackageOwnerContext(ctx.env, {
				user,
				request,
			})
			const nameInput = args.name?.trim() || undefined
			const leftoverKodyIdInput = args.kody_id?.trim() || undefined
			if (nameInput !== undefined && leftoverKodyIdInput !== undefined) {
				throw new McpCallerError(
					'Provide `name` or leftover `kody_id`, not both. Prefer `name`.',
				)
			}
			const packageNameInput = nameInput ?? leftoverKodyIdInput
			const requestedKodyId =
				packageNameInput === undefined
					? undefined
					: normalizePackageNameInput({
							value: packageNameInput,
							ownerScope: owner.ownerScope,
							action: args.create ? 'create' : 'resolve',
						})
			const access = await computeEffectivePermissions({
				env: ctx.env,
				request,
			})
			let created = false
			let scope: 'read' | 'write' | undefined
			if (args.create) {
				if (requestedKodyId === undefined || args.package_id !== undefined) {
					throw new McpCallerError(
						'`create: true` requires `name` (package name leaf or `@scope/leaf`) without `package_id`; new package ids are generated by Kody.',
					)
				}
				const existing = await resolveSavedPackageRef(ctx.env.APP_DB, {
					userId: owner.ownerUserId,
					ref: requestedKodyId,
					match: 'slug',
				})
				if (!existing) {
					// Creating is the grant: `package:create` covers minting the
					// first remote, write included, for this new package only.
					// Authorized before the stub exists so a denial leaves no orphan.
					await authorizePackageCreate(authorizeCtx)
					scope = pickGitRemoteAccessScope({
						requested: args.scope,
						canWrite: true,
					})
					await createStubSavedPackage({
						env: ctx.env,
						baseUrl: ctx.callerContext.baseUrl,
						owner,
						kodyId: requestedKodyId,
						description: args.description,
					})
					created = true
				}
			}
			const { source, packageId, userId, kodyId, name } =
				await resolveOwnedPackageSource({
					db: ctx.env.APP_DB,
					userId: owner.ownerUserId,
					ownerScope: owner.ownerScope,
					args: {
						package_id: args.package_id,
						kody_id: requestedKodyId,
					},
				})
			const pkg = { id: packageId, userId, label: name }
			const resource = packageResource(pkg)
			const resourceLabel = `package ${name}`
			if (!created) {
				// Existing package: mint access is resource-scoped (profiles/grants).
				const canWrite = checkPermission(
					access,
					'package:write',
					resource,
				).allowed
				const canRead =
					canWrite || checkPermission(access, 'package:read', resource).allowed
				scope = pickGitRemoteAccessScope({
					requested: args.scope,
					canWrite,
				})
				try {
					if (scope === 'write') {
						await authorize(authorizeCtx, 'package:write', resource)
					} else {
						await authorize(authorizeCtx, 'package:read', resource)
					}
				} catch (error) {
					if (error instanceof AuthorizationError) {
						throw scope === 'write'
							? enhanceGitRemoteWriteDenial({
									error,
									resourceLabel,
									operation: 'packageGetGitRemote',
									canRead,
								})
							: enhanceGitRemoteReadDenial({
									error,
									resourceLabel,
									operation: 'packageGetGitRemote',
								})
					}
					throw error
				}
			}
			if (scope === undefined) {
				throw new Error('packageGetGitRemote failed to resolve mint scope.')
			}
			const headPromise = assertPublishedPackageSourceRepoHead({
				env: ctx.env,
				source,
				operation: 'packageGetGitRemote',
				accessToken: {
					scope,
					ttlSeconds: args.ttl_seconds,
				},
			})
			let sourceHead: Awaited<typeof headPromise>
			if (scope === 'write') {
				const [snapshotResult, headResult] = await Promise.allSettled([
					assertRestorablePackageSourceSnapshot({
						env: ctx.env,
						userId: owner.ownerUserId,
						source,
						operation: 'packageGetGitRemote write access',
					}),
					headPromise,
				])
				if (snapshotResult.status === 'rejected') {
					throw snapshotResult.reason
				}
				if (headResult.status === 'rejected') {
					throw headResult.reason
				}
				sourceHead = headResult.value
			} else {
				sourceHead = await headPromise
			}
			if (!sourceHead) {
				throw new Error('packageGetGitRemote requires a package source.')
			}
			const token = sourceHead.accessToken
			if (!token) {
				throw new Error(
					'packageGetGitRemote failed to mint an artifact access token.',
				)
			}
			if (scope === 'write') {
				await markEntitySourcePendingExternalReconcile(ctx.env.APP_DB, {
					id: source.id,
					userId: owner.ownerUserId,
					tokenExpiresAt: token.expiresAt,
				})
			}
			const gitExtraHeader = `Authorization: Bearer ${parseArtifactTokenSecret(token.plaintext)}`
			const cloneDirectory = source.entity_id
			const setupCommands = [
				`git -c http.extraHeader=${shellQuote(gitExtraHeader)} clone ${shellQuote(sourceHead.remote)} ${shellQuote(cloneDirectory)}`,
				`cd ${shellQuote(cloneDirectory)}`,
				...gitAuthorSetupCommands(gitAuthor),
				`git remote add kody ${shellQuote(sourceHead.remote)}`,
				`git config remote.kody.fetch '+refs/heads/*:refs/remotes/kody/*'`,
				`git config --add remote.kody.fetch '+refs/notes/*:refs/notes/*'`,
				`git -c http.extraHeader=${shellQuote(gitExtraHeader)} fetch kody 'refs/notes/*:refs/notes/*'`,
			]
			if (scope === 'write') {
				setupCommands.push(
					`git -c http.extraHeader=${shellQuote(gitExtraHeader)} push kody HEAD:${shellQuote(sourceHead.defaultBranch)}`,
				)
			}
			return {
				package_id: packageId,
				kody_id: kodyId,
				slug: kodyId,
				created,
				remote: sourceHead.remote,
				authenticated_remote: buildAuthenticatedArtifactsRemote({
					remote: sourceHead.remote,
					token: token.plaintext,
				}),
				git_extra_header: gitExtraHeader,
				scope,
				expires_at: token.expiresAt,
				git_author: gitAuthor,
				setup_commands: setupCommands,
			}
		},
	},
)
