/** @jsxImportSource @emotion/react */
import { useLocation, useParams } from '@tanstack/react-router'
import { buildPermissionDeniedErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { ErrorAgentPromptButton } from './error-agent-prompt-button.tsx'
import { isPermissionDeniedError } from '#universal/permission-denied.ts'
import { orgGrantsPath } from '#universal/org-pages.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	illustratedErrorActionsCss,
	illustratedErrorCopyCss,
	illustratedErrorHeadingCss,
	illustratedErrorPageCss,
} from '#client/illustrated-error-page.ts'
import { routes } from '#universal/routes.ts'
import { InternalErrorPage } from './internal-error-page.tsx'
import { SiteLink } from './site-link.tsx'

/** Route boundary: expected permission denials get a 403 explainer. */
export function RouteErrorPage({ error }: { error: unknown }) {
	const orgSlug = useParams({
		strict: false,
		select: (params) =>
			'orgSlug' in params && typeof params.orgSlug === 'string'
				? params.orgSlug
				: null,
	})
	return isPermissionDeniedError(error) ? (
		<PermissionDeniedPage message={error.message} orgSlug={orgSlug} />
	) : (
		<InternalErrorPage />
	)
}

export function PermissionDeniedPage({
	message,
	orgSlug,
}: {
	message: string
	orgSlug: string | null
}) {
	const path = useLocation({ select: (location) => location.pathname })
	return (
		<section data-testid="permission-denied-page" css={illustratedErrorPageCss}>
			<h1 css={illustratedErrorHeadingCss}>
				You do not have access to this page
			</h1>
			<p css={illustratedErrorCopyCss}>{message}</p>
			<p css={illustratedErrorCopyCss}>
				{orgSlug
					? 'An org Owner can grant access org-wide on the Grants page.'
					: 'Ask an owner for access, then try again.'}
			</p>
			<nav aria-label="What to try next" css={illustratedErrorActionsCss}>
				{orgSlug ? (
					<SiteLink href={orgGrantsPath(orgSlug)} css={getPillButtonCss()}>
						Open Grants
					</SiteLink>
				) : null}
				<SiteLink href={routes.home.href()} css={getGhostButtonCss()}>
					Go home
				</SiteLink>
			</nav>
			<ErrorAgentPromptButton
				prompt={buildPermissionDeniedErrorAgentPrompt({
					path,
					message,
					orgSlug,
				})}
			/>
		</section>
	)
}
