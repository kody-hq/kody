/** @jsxImportSource @emotion/react */
import { orgGrantsPath } from '#universal/org-pages.ts'
import { surfaceCardCss } from '#universal/styles/surface.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { renderIcon } from './icon.tsx'
import { SiteLink } from './site-link.tsx'

/**
 * Shown in place of org run history (Activity, Overview runs and charts) when
 * the viewer lacks org-wide `job:read`. A permission state, not an error.
 */
export function RunHistoryAccessNotice({
	orgSlug,
	compact = false,
}: {
	orgSlug: string
	compact?: boolean
}) {
	return (
		<section
			data-testid="run-history-access-notice"
			aria-labelledby="run-history-access-heading"
			css={{
				...surfaceCardCss,
				display: 'grid',
				gap: spacing.sm,
				justifyItems: 'start',
				padding: compact ? spacing.md : spacing.lg,
				maxWidth: '46rem',
			}}
		>
			<h2
				id="run-history-access-heading"
				css={{
					margin: 0,
					display: 'flex',
					alignItems: 'center',
					gap: spacing.xs,
					fontSize: compact ? typography.fontSize.base : typography.fontSize.lg,
				}}
			>
				{renderIcon('lock')} Run history needs read access to jobs
			</h2>
			<p css={{ margin: 0, color: colors.textMuted, lineHeight: 1.5 }}>
				Your role in this organization doesn't include its run history. An org
				Owner can turn on <strong>Jobs and run history</strong> for you, or for
				a team you're on, under Organization-wide read access on the Grants
				page. It's read-only: you won't be able to run, change, or triage
				anything.
			</p>
			<SiteLink href={orgGrantsPath(orgSlug)} css={getPillButtonCss()}>
				Open Grants
			</SiteLink>
		</section>
	)
}
