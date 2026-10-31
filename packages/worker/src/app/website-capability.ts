import { waitUntil } from 'cloudflare:workers'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	type Capability,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { type OrgBinding } from '#worker/orgs/repo.ts'

type WebsiteUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export type WebsiteCapabilityCaller = {
	env: Env
	request: Request
	user: WebsiteUser
	/** Defaults to the org the signed-in website request is bound to. */
	orgBinding?: OrgBinding
}

/** The capability context a signed-in website request runs capabilities as. */
export function websiteCapabilityContext(
	input: WebsiteCapabilityCaller,
): CapabilityContext {
	const orgBinding = input.orgBinding ?? {
		org: input.user.request.org,
		role: input.user.request.membership?.role ?? null,
	}
	return {
		env: input.env,
		callerContext: createMcpCallerContext({
			baseUrl: getAppBaseUrl({ env: input.env, requestUrl: input.request.url }),
			source: { kind: 'session' },
			executionOrigin: 'interactive',
			user: input.user.mcpUser,
			orgBinding,
		}),
		waitUntil,
	}
}

/**
 * Run a capability for the website, so its permission checks, input parsing,
 * and side effects match API, MCP, CLI, and package callers exactly.
 */
export function callCapabilityAsWebsite<TOutput>(
	caller: WebsiteCapabilityCaller | CapabilityContext,
	capability: Capability<TOutput>,
	args: Record<string, unknown>,
): Promise<TOutput> {
	const ctx =
		'callerContext' in caller ? caller : websiteCapabilityContext(caller)
	return capability.handler(args, ctx)
}
