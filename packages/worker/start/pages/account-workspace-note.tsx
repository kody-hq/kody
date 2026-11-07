/** @jsxImportSource @emotion/react */
import { orgOverviewPath } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import { getAccentCalloutCss } from '#universal/styles/style-primitives.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { SiteLink } from '../components/site-link.tsx'

/**
 * Account settings hold only the person's pages. This note points to where
 * MCP servers, secrets, and the rest moved: the signup workspace, whose slug
 * is the username, and the Organizations page for team workspaces.
 */
export function AccountWorkspaceNote({ username }: { username: string }) {
	return (
		<aside
			aria-label="Workspace resources"
			data-testid="account-workspace-note"
			css={getAccentCalloutCss()}
		>
			<p css={{ margin: 0, color: colors.text }}>
				MCP servers, secrets, repositories, and jobs live in your workspace, not
				in account settings.
			</p>
			<p css={{ margin: 0, fontSize: typography.fontSize.sm }}>
				<SiteLink
					href={orgOverviewPath(username)}
					data-testid="account-workspace-note-link"
					css={linkCss}
				>
					Open the @{username} workspace
				</SiteLink>
				{' · '}
				<SiteLink href={routes.accountOrganizations.href()} css={linkCss}>
					Team workspaces
				</SiteLink>
			</p>
		</aside>
	)
}

const linkCss = {
	color: colors.primaryText,
	fontWeight: typography.fontWeight.semibold,
}
