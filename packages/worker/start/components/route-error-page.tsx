/** @jsxImportSource @emotion/react */
import { Button } from './button.tsx'
import { useLocation, useParams } from '@tanstack/react-router'
import { buildPermissionDeniedErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { ErrorAgentPromptButton } from './error-agent-prompt-button.tsx'
import {
	isPermissionDeniedError,
	readDeniedPermission,
} from '#universal/permission-denied.ts'
import { orgGrantsPath, orgMembersPath } from '#universal/org-pages.ts'
import {
	illustratedErrorActionsCss,
	illustratedErrorCopyCss,
	illustratedErrorHeadingCss,
	illustratedErrorPageCss,
} from '#client/illustrated-error-page.ts'
import { routes } from '#universal/routes.ts'
import { InternalErrorPage } from './internal-error-page.tsx'

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
		<PermissionDeniedPage
			message={error.message}
			permission={readDeniedPermission(error)}
			orgSlug={orgSlug}
		/>
	) : (
		<InternalErrorPage />
	)
}

function PermissionDeniedPage({
	message,
	permission,
	orgSlug,
}: {
	message: string
	permission: string | null
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
				{!orgSlug ? (
					'Ask an owner for access, then try again.'
				) : permission ? (
					<>
						An org Owner can grant <code>{permission}</code> org-wide on the
						Grants page.
					</>
				) : (
					'Access comes from your role in this org. Ask an org Owner to change it.'
				)}
			</p>
			<nav aria-label="What to try next" css={illustratedErrorActionsCss}>
				{orgSlug ? (
					permission ? (
						<Button href={orgGrantsPath(orgSlug)} variant="primary">
							Open Grants
						</Button>
					) : (
						<Button href={orgMembersPath(orgSlug)} variant="primary">
							See members
						</Button>
					)
				) : null}
				<Button href={routes.home.href()} variant="secondary">
					Go home
				</Button>
			</nav>
			<ErrorAgentPromptButton
				prompt={buildPermissionDeniedErrorAgentPrompt({
					path,
					message,
					permission,
					orgSlug,
				})}
			/>
		</section>
	)
}
