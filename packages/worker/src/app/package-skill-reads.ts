import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { type PackageFilesLoaderData } from '#universal/loader-data.ts'
import {
	type SkillReadResource,
	issueSkillReadReceipt,
	skillFileReadResource,
	recordSkillRead,
} from '#worker/package-registry/skill-read-events.ts'
import { readAuthenticatedAppUser } from './authenticated-user.ts'
import { loadPackagePage } from './package-page.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'

export async function packageSkillReadReceipt(
	env: Env,
	request: Request,
	data: PackageFilesLoaderData,
) {
	const path = data.contentPath
	if (
		!data.username ||
		!data.kodyId ||
		!path?.startsWith('skills/') ||
		data.content == null ||
		data.kind !== 'file'
	)
		return null
	const resourceRequest = new Request(
		new URL(`/@${data.username}/${data.kodyId}`, request.url),
	)
	const user = await readAuthenticatedAppUser(request, env, {
		resourceRequest,
	})
	if (!user?.request.actor || !user.request.org.slug) return null
	const page = await loadPackagePage({
		env,
		request,
		username: data.username,
		kodyId: data.kodyId,
	})
	if (
		page.kind !== 'page' ||
		!page.ownerPackage ||
		page.ownerUserId !== user.request.org.id
	)
		return null
	const files = Object.fromEntries(data.paths.map((path) => [path, '']))
	files[path] = data.content
	const resource = await skillFileReadResource({
		packageId: page.ownerPackage.id,
		packageName: `@${data.username}/${data.kodyId}`,
		packageOwnerId: page.ownerUserId,
		publishedCommit: data.viewedCommit ?? null,
		files,
		path,
	})
	if (!resource) return null
	return {
		orgSlug: user.request.org.slug,
		receipt: await issueSkillReadReceipt(env.COOKIE_SECRET, {
			resource,
			actorId: user.request.actor.userId,
			orgId: user.request.org.id,
			channel: 'package-file',
		}),
	}
}

export async function recordRawSkillRead(input: {
	env: Env
	request: Request
	resource?: SkillReadResource | null
	callerContext?: McpCallerContext | null
	allowSession?: boolean
	tokenOrgId?: string | null
}) {
	if (
		!input.resource ||
		input.request.method !== 'GET' ||
		input.request.headers.get('Sec-Purpose')?.includes('prefetch') ||
		input.request.headers.get('Purpose') === 'prefetch'
	)
		return
	const user =
		input.callerContext || input.allowSession === false
			? null
			: await readAuthenticatedAppUser(input.request, input.env)
	let callerContext =
		input.callerContext ??
		(user
			? {
					...createMcpCallerContext({
						baseUrl: new URL(input.request.url).origin,
						user: user.mcpUser,
						source: { kind: 'session' },
					}),
					request: user.request,
				}
			: null)
	if (!callerContext?.request || !callerContext.user) return
	if (input.tokenOrgId && input.tokenOrgId !== input.resource.packageOwnerId)
		return
	if (callerContext.request.org.id !== input.resource.packageOwnerId) {
		const binding = await loadOrgBindingForOrg(
			input.env.APP_DB,
			callerContext.user.userId,
			input.resource.packageOwnerId,
		)
		if (!binding) return
		callerContext = {
			...callerContext,
			request: {
				...callerContext.request,
				org: binding.org,
				membership: binding.role ? { role: binding.role } : null,
			},
		}
	}

	await recordSkillRead({
		...input,
		callerContext,
		channel: 'raw-file',
		resource: input.resource,
	})
}
