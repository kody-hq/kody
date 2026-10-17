/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { type ReactNode } from 'react'
import { recordCellClamp, recordStampCss } from './record-table.tsx'
import { inlineWorkflowNameSubtitle } from '#universal/workflow-display.ts'
import { colors, typography } from '#universal/styles/tokens.ts'

const clampedNameCss = recordCellClamp(28)

const headingSubtitleCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

export function renderWorkflowNameCell(input: {
	name: string
	idempotencyKey?: string | null
}): ReactNode {
	const subtitle = inlineWorkflowNameSubtitle(input.name, input.idempotencyKey)
	return (
		<span css={{ display: 'grid', gap: '0.125rem', minWidth: 0 }}>
			<span css={clampedNameCss}>{input.name}</span>
			{subtitle ? <span css={recordStampCss}>{subtitle}</span> : null}
		</span>
	)
}

export function renderInlineWorkflowNameSubtitle(input: {
	displayedName: string
	idempotencyKey?: string | null
}): ReactNode {
	const subtitle = inlineWorkflowNameSubtitle(
		input.displayedName,
		input.idempotencyKey,
	)
	if (!subtitle) return null
	return <p css={headingSubtitleCss}>{subtitle}</p>
}
