/** @jsxImportSource @emotion/react */
import { type RepositoryOwnerOption } from '#universal/repository-create.ts'
import { getSelectCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { type CommunityInstallOrgPicker } from '../use-community-install-org.ts'

function installOrgOptionLabel(owner: RepositoryOwnerOption) {
	if (owner.personal) return 'Personal workspace'
	return owner.displayName?.trim() || `@${owner.slug}`
}

/**
 * Picks the org one-click install forks into. Only orgs where the viewer may
 * create packages are offered, personal first.
 */
export function CommunityInstallOrgSelect(props: {
	picker: CommunityInstallOrgPicker
	disabled?: boolean
	/** Pill-height control for the package title action row. */
	compact?: boolean
}) {
	const { owners, selected, onSelect } = props.picker
	const personal = owners.find((owner) => owner.personal)
	const value = selected ?? personal?.slug ?? owners[0]?.slug ?? ''
	return (
		<label css={props.compact ? [fieldCss, compactControlCss] : fieldCss}>
			<span css={labelCss}>Fork into</span>
			<select
				data-testid="community-install-org"
				disabled={props.disabled}
				css={getSelectCss()}
				value={value}
				onChange={(event) => onSelect(event.currentTarget.value)}
			>
				{owners.map((owner) => (
					<option key={owner.slug} value={owner.slug}>
						{installOrgOptionLabel(owner)}
					</option>
				))}
			</select>
		</label>
	)
}

const fieldCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.sm,
}

/** Same compact control tokens the workspace panel sets for its fields. */
const compactControlCss = {
	'--control-font-size': '0.875rem',
	'--control-line-height': '1.5',
	'--control-padding-y': '0.375rem',
	'--control-padding-x': '0.625rem',
}

const labelCss = {
	color: colors.text,
	fontWeight: typography.fontWeight.medium,
	fontSize: typography.fontSize.sm,
	whiteSpace: 'nowrap' as const,
}
