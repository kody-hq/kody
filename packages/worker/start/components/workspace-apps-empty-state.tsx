/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import {
	AccountManagementPanel,
	accountActionsCss,
} from '../pages/account-management-components.tsx'
import { SiteLink } from './site-link.tsx'
import { CopyTextButton } from './copy-text-button.tsx'
import { buildCommunityIndexHref } from '#universal/community-search.ts'
import { workspaceAppsAgentPrompt } from '#universal/workspace-apps-agent-prompt.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'

/**
 * First-use panel when a workspace has no hosted apps yet. Copying the
 * prompt does not run anything; the person pastes it into their agent.
 */
export function WorkspaceAppsEmptyState(props: { orgSlug: string }) {
	const prompt = workspaceAppsAgentPrompt(props.orgSlug)
	const exploreHref = buildCommunityIndexHref({
		category: 'apps',
		installOrg: props.orgSlug,
	})
	return (
		<AccountManagementPanel
			title="No apps in this workspace yet"
			description="Apps are dashboards and tools your agent builds and hosts in Kody. Ask your agent to build one for this workspace — a dashboard is a good first win."
		>
			<div css={emptyActionsCss} data-testid="workspace-apps-empty">
				<div css={accountActionsCss}>
					<CopyTextButton
						value={prompt}
						variant="pill"
						size="sm"
						idleLabel="Copy a prompt for my agent"
						copiedLabel="Copied"
						ariaLabel="Copy a prompt for my agent"
					/>
					<SiteLink
						href={exploreHref}
						css={getGhostButtonCss({ size: 'sm' })}
						data-testid="workspace-apps-explore-forks"
					>
						Explore apps you can fork
					</SiteLink>
				</div>
			</div>
		</AccountManagementPanel>
	)
}

const emptyActionsCss = css({
	display: 'grid',
	gap: 12,
})
