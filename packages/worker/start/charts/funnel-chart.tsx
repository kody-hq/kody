/** @jsxImportSource @emotion/react */
import { useMemo } from 'react'
import { barX, defineChart } from '@tanstack/charts'
import { decorative } from '@tanstack/charts/mark/decorative'
import { Chart } from '@tanstack/charts/react'
import { scaleBand } from '@tanstack/charts/scales/band'
import { scaleLinear } from '@tanstack/charts/scales/linear'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	formatIntegerNumber,
	formatPercentShare,
} from '#client/charts/chart-theme.ts'

type FunnelStep = { key: string; label: string; users: number; color: string }

export function FunnelChart({
	steps,
	ariaLabel,
}: {
	steps: Array<FunnelStep>
	ariaLabel: string
}) {
	const total = steps[0]?.users ?? 0
	return (
		<div
			aria-label={ariaLabel}
			role="group"
			css={{ display: 'grid', gap: spacing.sm }}
		>
			{steps.map((step) => (
				<FunnelRow key={step.key} step={step} total={total} />
			))}
		</div>
	)
}

function FunnelRow({ step, total }: { step: FunnelStep; total: number }) {
	const share = total > 0 ? step.users / total : 0
	const definition = useMemo(
		() =>
			defineChart({
				marks: [
					decorative(
						barX([{ value: Math.max(1, total), row: step.key }], {
							x: 'value',
							y: 'row',
							fill: colors.border,
							radius: 5,
						}),
					),
					barX([{ value: step.users, row: step.key }], {
						x: 'value',
						y: 'row',
						fill: step.color,
						radius: 5,
					}),
				],
				scales: {
					x: {
						scale: scaleLinear,
						domain: [0, Math.max(1, total, step.users)],
					},
					y: { scale: scaleBand<string> },
				},
				guides: false,
			}),
		[step, total],
	)
	return (
		<div css={{ display: 'grid', gap: spacing.xs }}>
			<div
				css={{
					display: 'flex',
					justifyContent: 'space-between',
					gap: spacing.sm,
					fontSize: typography.fontSize.sm,
					color: colors.text,
				}}
			>
				<span>{step.label}</span>
				<span
					css={{
						color: colors.textMuted,
						whiteSpace: 'nowrap',
						fontVariantNumeric: 'tabular-nums',
					}}
				>
					{formatIntegerNumber(step.users)} · {formatPercentShare(share)}
				</span>
			</div>
			<Chart
				definition={definition}
				height={10}
				initialWidth={400}
				ariaLabel={`${step.label}: ${formatIntegerNumber(step.users)} users, ${formatPercentShare(share)} of signups`}
			/>
		</div>
	)
}
