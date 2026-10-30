import { optionalOrgAuditWriter } from '#worker/orgs/org-audit.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import { buildSavedPackageEmbedText } from '#worker/package-registry/embed.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { normalizePackageNameInput } from '#worker/package-registry/package-name.ts'
import {
	packageOwnerEntitlementEmail,
	type PackageOwnerContext,
} from '#worker/package-registry/package-owner.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { refreshSavedPackageProjection } from '#worker/package-registry/service.ts'
import { scheduleKitSubscriberSync } from '#worker/kit/subscriber-sync.ts'
import { assertKodyDescriptionLength } from '#worker/package-registry/types.ts'
import { upsertSavedPackageVector } from '#worker/package-registry/vectorize.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'

export const defaultStubPackageDescription =
	'Stub package created for a clone-edit-push workflow. Replace this description on the first real publish.'

export function buildStubPackageFiles(input: {
	name: string
	description: string
}): Record<string, string> {
	// Authored `kody.id` is leftover identity (#1909). Stubs write `name` only;
	// the parser derives the leaf when present and accepts a matching authored id.
	const packageJson = {
		name: input.name,
		private: true,
		exports: { '.': './src/index.ts' },
		kody: {
			description: input.description,
		},
	}
	return {
		'package.json': `${JSON.stringify(packageJson, null, '\t')}\n`,
		'README.md': [
			`# ${input.name}`,
			'',
			'## Intent',
			'',
			input.description,
			'',
			'Update this Intent section to capture the user-defined goal before',
			'publishing real package source.',
			'',
		].join('\n'),
		'AGENTS.md': [
			`# ${input.name}`,
			'',
			'Agent-focused notes: imports, smoke tests, and edge cases.',
			'',
			'## Imports',
			'',
			'```ts',
			`import main from 'kody:${input.name}'`,
			'```',
			'',
			'## Smoke tests',
			'',
			'Before publish (`guide:package_lifecycle`): session/tool-only lane —',
			'`repoRunChecks` then `repoPublishSession`; git lane — local checks,',
			'commit, push, then `packagePublishExternalPush` (server-side checks;',
			'sessions refuse unpublished HEAD).',
			'After publish, when Node ≥22 + CLI are available, prefer',
			'`npx @kodycodes/cli execute --local` (`kody login` or headless',
			'`KODY_API_TOKEN`; `guide:local_execute`). MCP-only hosts (no shell)',
			'smoke with the matching post-publish surface or a static `kody:@…`',
			'import from `execute` when that tool is on the session.',
			'Do not assume every agent can run the CLI.',
			'',
			'## Edge cases',
			'',
			'Replace this stub before the first real publish.',
			'',
		].join('\n'),
		'src/index.ts': [
			'export default async function main() {',
			"\treturn { status: 'stub' }",
			'}',
			'',
		].join('\n'),
	}
}

export async function createStubSavedPackage(input: {
	env: Env
	baseUrl: string
	owner: PackageOwnerContext
	kodyId: string
	description?: string
}) {
	const kodyId = normalizePackageNameInput({
		value: input.kodyId,
		ownerScope: input.owner.ownerScope,
		action: 'create',
	})
	await assertWithinEntitlement({
		db: input.env.APP_DB,
		userId: input.owner.ownerUserId,
		email: packageOwnerEntitlementEmail(input.owner),
		resource: 'saved_packages',
	})
	const name = `@${input.owner.ownerScope}/${kodyId}`
	const description = input.description?.trim() || defaultStubPackageDescription
	try {
		assertKodyDescriptionLength(description)
	} catch (error) {
		// Oversized taglines are caller-fixable. Wrap so handler failures stay
		// off Sentry even if the packageGetGitRemote schema max is bypassed.
		throw new McpCallerError(getErrorMessage(error), { cause: error })
	}
	return await createSavedPackageFromFiles({
		env: input.env,
		baseUrl: input.baseUrl,
		owner: input.owner,
		files: buildStubPackageFiles({ name, description }),
	})
}

/**
 * Publish `files` as a new private saved package owned by `owner`, then
 * refresh its projection (which syncs any `kody.jobs` into job rows).
 */
export async function createSavedPackageFromFiles(input: {
	env: Env
	baseUrl: string
	owner: PackageOwnerContext
	files: Record<string, string>
}) {
	const { files } = input
	const packageJsonContent = files['package.json']
	if (!packageJsonContent) {
		throw new Error('Package files are missing package.json.')
	}
	const manifest = parseAuthoredPackageJson({
		content: packageJsonContent,
		manifestPath: 'package.json',
		expectedPackageScope: input.owner.ownerScope,
	})
	const packageId = crypto.randomUUID()
	const ensuredSource = await ensureEntitySource({
		db: input.env.APP_DB,
		env: input.env,
		userId: input.owner.ownerUserId,
		entityKind: 'package',
		entityId: packageId,
		sourceRoot: '/',
		manifestPath: 'package.json',
		requirePersistence: true,
	})
	await syncArtifactSourceSnapshot({
		env: input.env,
		userId: input.owner.ownerUserId,
		baseUrl: input.baseUrl,
		sourceId: ensuredSource.id,
		bootstrapAccess: ensuredSource.bootstrapAccess ?? null,
		files,
	})
	const now = new Date().toISOString()
	const stamped = await insertSavedPackage(
		input.env.APP_DB,
		{
			id: packageId,
			user_id: input.owner.ownerUserId,
			name: manifest.name,
			description: manifest.kody.description,
			tags_json: JSON.stringify(manifest.kody.tags ?? []),
			search_text: manifest.kody.searchText ?? null,
			source_id: ensuredSource.id,
			has_app: manifest.kody.app ? 1 : 0,
			has_skills: 0,
			hidden: 0,
			is_private: 1,
			created_at: now,
			updated_at: now,
		},
		input.env,
		{ actorUserId: input.owner.actorUserId },
	)
	if (stamped) {
		scheduleKitSubscriberSync({
			env: input.env,
			stableUserId: input.owner.actorUserId,
		})
	}
	await upsertSavedPackageVector(input.env, {
		packageId,
		userId: input.owner.ownerUserId,
		embedText: buildSavedPackageEmbedText(manifest),
	})
	await refreshSavedPackageProjection({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.owner.ownerUserId,
		actorUserId: input.owner.actorUserId,
		userEmail: packageOwnerEntitlementEmail(input.owner),
		packageId,
		sourceId: ensuredSource.id,
		firstPublish: true,
		creatorUserId: input.owner.actorUserId,
		audit: optionalOrgAuditWriter(input.env, {
			userId: input.owner.actorUserId,
		}),
	})
	return { packageId, kodyId: manifest.kody.id, name: manifest.name }
}
