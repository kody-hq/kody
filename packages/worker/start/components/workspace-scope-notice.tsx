/** @jsxImportSource @emotion/react */
import {
	workspaceScopeActionLabel,
	workspaceScopeKind,
	type WorkspaceScopeKind,
} from '#universal/workspace-scope.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

export type WorkspaceScopeNoticeProps = {
	action: 'Creating in' | 'Saving to' | 'Running as' | 'Connecting in'
	slug: string
	personal: boolean
	/** Optional extra line under the chip (e.g. credential vs compute). */
	detail?: string | null
	testId?: string
}

/**
 * Persistent workspace identity on create/connect/setup surfaces so people
 * and agents see which org owns the resource before they commit.
 */
export function WorkspaceScopeNotice(props: WorkspaceScopeNoticeProps) {
	const kind: WorkspaceScopeKind = workspaceScopeKind(props.personal)
	return (
		<div
			css={noticeCss}
			data-testid={props.testId ?? 'workspace-scope-notice'}
			data-workspace-kind={kind}
			data-workspace-slug={props.slug}
		>
			<p css={labelCss}>
				{workspaceScopeActionLabel(props.action, {
					slug: props.slug,
					kind,
				})}
			</p>
			{props.detail ? <p css={detailCss}>{props.detail}</p> : null}
		</div>
	)
}

const noticeCss = {
	display: 'grid',
	gap: spacing.xs,
	padding: `${spacing.sm} ${spacing.md}`,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	background: colors.primarySoftest,
	minWidth: 0,
}

const labelCss = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
	overflowWrap: 'anywhere' as const,
}

const detailCss = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	overflowWrap: 'anywhere' as const,
}
