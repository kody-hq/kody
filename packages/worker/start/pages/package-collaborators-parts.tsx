/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import {
	type PackageCollaboratorPreset,
	type PackageCollaboratorView,
	isPackageCollaboratorPreset,
	packageCollaboratorKindLabel,
	packageCollaboratorPresetLabel,
	packageCollaboratorPresets,
} from '#universal/package-collaborators.ts'
import { accountInputCss } from './account-management-components.tsx'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

export function collaboratorName(collaborator: PackageCollaboratorView) {
	if (collaborator.subjectType === 'team') return collaborator.label
	return collaborator.displayName?.trim() || collaborator.label
}

export function collaboratorDetail(collaborator: PackageCollaboratorView) {
	const kind = packageCollaboratorKindLabel(collaborator.kind)
	if (collaborator.subjectType === 'team') {
		const count = collaborator.teamMemberCount
		return count === null
			? kind
			: `${kind} · ${count} ${count === 1 ? 'member' : 'members'}`
	}
	return collaborator.displayName?.trim()
		? `${collaborator.label} · ${kind}`
		: kind
}

export function readPreset(event: {
	currentTarget: HTMLSelectElement
}): PackageCollaboratorPreset | null {
	const value = (event.currentTarget as HTMLSelectElement).value
	return isPackageCollaboratorPreset(value) ? value : null
}

export function renderPresetOptions(
	_selected: PackageCollaboratorPreset | null,
) {
	return packageCollaboratorPresets.map((preset) => (
		<option key={preset} value={preset}>
			{packageCollaboratorPresetLabel(preset)}
		</option>
	))
}

export const mutedCopyCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
}

export const listCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

export const rowCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	minWidth: 0,
	padding: '0.85rem 1rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	[mq.mobile]: {
		flexWrap: 'wrap',
		alignItems: 'flex-start',
	},
}

export const rowTextCss: CSSObject = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
	flex: '1 1 auto',
	[mq.mobile]: {
		flex: '1 1 0%',
		maxWidth: '100%',
	},
}

export const rowNameCss: CSSObject = {
	fontWeight: 650,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
	[mq.mobile]: {
		whiteSpace: 'normal',
		overflowWrap: 'anywhere',
	},
}

export const rowDetailCss: CSSObject = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	minWidth: 0,
	[mq.mobile]: {
		overflowWrap: 'anywhere',
	},
}

export const rowActionsCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	alignItems: 'center',
	flexShrink: 0,
	[mq.mobile]: {
		flex: '1 0 100%',
		maxWidth: '100%',
		minWidth: 0,
	},
}

export const selectCss: CSSObject = {
	...accountInputCss,
	width: 'auto',
	minWidth: '8rem',
	padding: '0.45rem 0.7rem',
	[mq.mobile]: {
		minWidth: 'min(100%, 8rem)',
		maxWidth: '100%',
	},
}

export const formCss: CSSObject = {
	display: 'grid',
	gap: spacing.lg,
}

export const iconWellCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2.75rem',
	height: '2.75rem',
	flexShrink: 0,
	borderRadius: radius.full,
	color: colors.textMuted,
	backgroundColor: colors.background,
}
