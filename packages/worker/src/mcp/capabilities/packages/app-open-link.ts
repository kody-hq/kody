import {
	isPackageAppHostProbeFirstSegment,
	packageAppHostSystemPrefix,
} from '@kody-internal/shared/package-app-host-paths.ts'
import { z } from 'zod'
import { isPackageAppOauthHostAuthPathname } from '#universal/package-app-oauth-paths.ts'
import {
	createPackageAppOpenLinkToken,
	packageAppOpenLinkQueryParam,
	packageAppOpenLinkSessionTtlMs,
	packageAppOpenLinkTtlMs,
} from '#worker/app-visit/open-link.ts'
import type { AppVisitSessionCredential } from '#worker/app-visit/session-credential.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	assertAppVisitConsent,
	resolveAppVisitTarget,
} from '#mcp/capabilities/packages/app-visit-target.ts'
import { servePackageAppRequest } from '#worker/package-runtime/package-app-serve.ts'

export const appOpenLinkCapabilityName = 'appOpenLink'

const runtimeCallerErrorMessage =
	'appOpenLink runs for a person or their agent. Call it from an interactive MCP session, execute, the Open API, or the kody CLI. Package app and job code cannot call it.'

export const appOpenLinkCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: appOpenLinkCapabilityName,
		contextRuns: 'allow',
		orgPermission: 'none',
		description:
			'Get a link that opens a hosted package app in your own browser as the signed-in person, e.g. appOpenLink({ app: "@acme/board" }). The link works once, within 5 minutes, and signs that browser in to that one app for an hour with this credential\'s profile and scopes. Use appFetch for programmatic calls. See /docs/agent-apps.',
		keywords: [
			'app',
			'package app',
			'open app',
			'open link',
			'browser',
			'sign in',
			'signed url',
			'visit',
			'hosted app',
			'kody.run',
			'screenshot',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z
			.object({
				app: z
					.string()
					.min(1)
					.optional()
					.describe(
						'The app: @org/app (the owning org handle and the app name) or its hosted URL. A path in the address is used when path is omitted.',
					),
				package_id: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Saved package id of the app, as appList and packageList return it. Use instead of app.',
					),
				path: z
					.string()
					.optional()
					.describe(
						'Page to open, as a path after the app mount with any query string. Defaults to /.',
					),
			})
			.superRefine((value, ctx) => {
				if ((value.app === undefined) === (value.package_id === undefined)) {
					ctx.addIssue({
						code: 'custom',
						message: 'Provide exactly one of `app` or `package_id`.',
					})
				}
			}),
		outputSchema: z.object({
			url: z
				.string()
				.describe(
					'Open this in a browser once. Treat it like a password until it is used or expires.',
				),
			app: z.string().describe('The app the link opens: @org/app.'),
			expires_at: z
				.string()
				.describe('When the unused link stops working (ISO 8601).'),
			expires_in_seconds: z.number().int(),
			session_seconds: z
				.number()
				.int()
				.describe(
					'How long the browser stays signed in to this app after the link is opened.',
				),
		}),
		async handler(args, ctx) {
			const target = await resolveAppVisitTarget(
				ctx,
				args,
				appOpenLinkCapabilityName,
				runtimeCallerErrorMessage,
			)
			if (!target.hasAppHost) {
				throw new McpCallerError(
					'appOpenLink needs apps served on their own host, which this Kody deployment does not have. Use appFetch instead.',
				)
			}
			const url = new URL(target.url)
			if (url.searchParams.has(packageAppOpenLinkQueryParam)) {
				throw new McpCallerError(
					`appOpenLink path must not carry a ${packageAppOpenLinkQueryParam} query parameter.`,
				)
			}

			// Kody answers these on every app host itself, before any exchange.
			const firstSegment = url.pathname.split('/').find(Boolean) ?? ''
			const kodyPath =
				`/${firstSegment}` === packageAppHostSystemPrefix ||
				isPackageAppHostProbeFirstSegment(firstSegment)
					? `/${firstSegment}`
					: isPackageAppOauthHostAuthPathname(url.pathname)
						? '/_kody/auth'
						: null
			if (kodyPath) {
				throw new McpCallerError(
					`appOpenLink cannot open ${url.pathname}: ${kodyPath} is a Kody path on the app host, not a page of the app.`,
				)
			}

			// Everything a visit checks before app code runs, without running
			// it: a missing visitor credential is reported here, like appFetch.
			const preflight = await servePackageAppRequest({
				request: new Request(url, { headers: { Accept: 'text/html' } }),
				env: ctx.env,
				owner: target.owner,
				visitor: target.visitor,
				packagePath: target.packagePath,
				dispatch: { agent: true, preflight: true },
			})
			await assertAppVisitConsent(target, preflight, url.toString())
			if (preflight.status === 404) throw target.notFound()
			if (preflight.status >= 400) {
				// The browser would meet the same refusal after the exchange.
				const refusal = (await preflight.text()).slice(0, 500)
				throw new McpCallerError(
					`appOpenLink cannot open ${target.appLabel}: the app host refused the visit with ${preflight.status}.${refusal ? ` ${refusal}` : ''}`,
				)
			}

			const { credential } = target.callerRequest
			const profileId = credential.profileId ?? null
			const linkCredential: AppVisitSessionCredential = {
				kind: credential.kind,
				id: credential.id,
				scopes: credential.scopes ? [...credential.scopes] : null,
				...(profileId
					? {
							profileId,
							profileChain: [...(credential.profileChain ?? [])],
							profileOrgId:
								credential.profileOrgId ?? target.callerRequest.org.id,
						}
					: {}),
			}
			const now = Date.now()
			const { token, expiresAt } = await createPackageAppOpenLinkToken({
				env: ctx.env,
				claims: {
					stableUserId: target.visitor.userId,
					username: target.packagePath.username,
					kodyId: target.packagePath.kodyId,
					host: url.host,
					credential: linkCredential,
				},
				now,
			})
			url.searchParams.set(packageAppOpenLinkQueryParam, token)
			return {
				url: url.toString(),
				app: target.appLabel,
				expires_at: new Date(expiresAt).toISOString(),
				expires_in_seconds: Math.floor(packageAppOpenLinkTtlMs / 1000),
				session_seconds: Math.floor(packageAppOpenLinkSessionTtlMs / 1000),
			}
		},
	},
)
