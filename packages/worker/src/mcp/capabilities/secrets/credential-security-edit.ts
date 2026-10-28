/**
 * Widening a credential's fill placement or changing its inject is
 * website-only (ADR 0068, 2026-10-27). Code that runs with the credential's
 * authority (hosted or `--local` execute, package and app code) could otherwise
 * move a value somewhere the owner never chose. Narrowing placement and
 * non-security edits (provider) stay available to every caller.
 */
import { type CredentialInject } from '#worker/credentials/credential-fields.ts'
import { type CredentialFillPlacement } from '#worker/credentials/fill-placement.ts'
import { orgResourcePathForAccountPath } from '#universal/org-pages.ts'
import { buildAccountSecretPath } from '@kody-internal/shared/account-secret-route.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	buildSecretEditorUrl,
	secretPageOrgSlugFromCaller,
} from '#mcp/secrets/package-approval-url.ts'

const bodyLikeParts = ['query', 'path', 'body'] as const

/** True when `after` lets the credential fill a request part `before` did not. */
export function fillPlacementWidens(
	before: CredentialFillPlacement | null,
	after: CredentialFillPlacement | null,
): boolean {
	if (after === null) return before !== null
	if (before === null) return false
	if (after.headers !== undefined) {
		if (before.headers === undefined) return true
		if (after.headers === true) {
			if (before.headers !== true) return true
		} else if (before.headers !== true) {
			const allowed = new Set(before.headers.map((name) => name.toLowerCase()))
			if (after.headers.some((name) => !allowed.has(name.toLowerCase()))) {
				return true
			}
		}
	}
	return bodyLikeParts.some(
		(part) => after[part] === true && before[part] !== true,
	)
}

function canonicalInject(inject: CredentialInject) {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(inject).sort(([a], [b]) => a.localeCompare(b)),
		),
	)
}

export function credentialInjectChanges(
	before: CredentialInject,
	after: CredentialInject,
) {
	return canonicalInject(before) !== canonicalInject(after)
}

/**
 * Which code-running caller this is, from host-set signals only: hosted
 * execute carries no `openApiPrincipal`, the local CapabilityProxy sets
 * `localExecuteHop`, and package or app runtimes carry their storage context.
 * Null for the MCP `api` tool and direct Open API calls.
 */
export function codeRunningCredentialEditor(
	ctx: CapabilityContext,
): string | null {
	if (ctx.localExecuteHop) return 'execute --local code'
	const storageContext = ctx.callerContext.storageContext
	if (storageContext?.appId) return 'app code'
	if (storageContext?.packageId) return 'package code'
	if (!ctx.openApiPrincipal) return 'execute code'
	return null
}

function credentialPageUrl(
	ctx: CapabilityContext,
	credential: { kind: string; name: string },
) {
	const baseUrl = ctx.callerContext.baseUrl
	const orgSlug = secretPageOrgSlugFromCaller(ctx.callerContext)
	if (credential.kind === 'secret' && orgSlug) {
		return buildSecretEditorUrl({
			baseUrl,
			orgSlug,
			name: credential.name,
			scope: 'user',
			packageId: null,
			sessionId: null,
		})
	}
	const accountPath =
		credential.kind === 'secret'
			? buildAccountSecretPath({ name: credential.name, scope: 'user' })
			: '/account/credentials'
	const path =
		(orgSlug && orgResourcePathForAccountPath(accountPath, orgSlug)) ||
		accountPath
	return new URL(path, baseUrl).toString()
}

/**
 * Refuses a placement widening or inject change from code-running callers,
 * pointing at the credential's page on the website.
 */
export function assertCredentialSecurityEditAllowed(
	ctx: CapabilityContext,
	input: {
		credential: { kind: string; name: string }
		before: {
			inject: CredentialInject
			placement: CredentialFillPlacement | null
		}
		after: {
			inject?: CredentialInject
			placement?: CredentialFillPlacement | null
		}
	},
) {
	const caller = codeRunningCredentialEditor(ctx)
	if (!caller) return
	const widens =
		input.after.placement !== undefined &&
		fillPlacementWidens(input.before.placement, input.after.placement)
	const changesInject =
		input.after.inject !== undefined &&
		credentialInjectChanges(input.before.inject, input.after.inject)
	if (!widens && !changesInject) return
	const change =
		widens && changesInject
			? 'widen its placement or change its inject'
			: widens
				? 'widen its placement'
				: 'change its inject'
	throw new McpCallerError(
		`${caller} cannot ${change} for credential "${input.credential.name}". Make this change on the credential's page on the website: ${credentialPageUrl(ctx, input.credential)}. Narrowing placement and provider changes still work here.`,
	)
}
