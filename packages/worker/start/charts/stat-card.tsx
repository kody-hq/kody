/** @jsxImportSource @emotion/react */
import { surfaceCardCss } from '#universal/styles/surface.ts'

import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import { useMemo } from 'react'
import { areaY, defineChart, lineY, dot } from '@tanstack/charts'
import { decorative } from '@tanstack/charts/mark/decorative'
import { Chart } from './chart.tsx'
import { scaleLinear } from '@tanstack/charts/scales/linear'
import { d3Curve } from '@tanstack/charts/d3/shape'
import { curveMonotoneX } from 'd3-shape'

const smoothCurve = d3Curve(curveMonotoneX)

type StatCardProps = {
	/** Unique id prefix for the sparkline. */
	id: string
	label: string
	value: string
	sub?: string
	color: string
	/** Optional small trend line rendered along the card bottom. */
	sparkValues?: Array<number>
}

/**
 * KPI tile with an accent color, a big value, and an optional sparkline.
 */
export function StatCard(props: StatCardProps) {
	const { id, label, value, sub, color, sparkValues } = props
	const hasSparkline = Boolean(sparkValues && sparkValues.length > 1)
	return (
		<div
			css={{
				position: 'relative',
				overflow: 'hidden',
				display: 'grid',
				gap: spacing.xs,
				alignContent: 'start',
				padding: spacing.lg,
				// Keep the sub text clear of the sparkline strip.
				paddingBottom: hasSparkline ? '2.75rem' : spacing.lg,
				...surfaceCardCss,

				minHeight: '6.5rem',
				minWidth: 0,
				[mq.mobile]: {
					padding: spacing.md,
					paddingBottom: hasSparkline ? '2.5rem' : spacing.md,
				},
			}}
		>
			<span
				css={{
					display: 'flex',
					alignItems: 'center',
					gap: spacing.sm,
					fontSize: typography.fontSize.xs,
					letterSpacing: '0.08em',
					textTransform: 'uppercase',
					color: colors.textMuted,
					fontWeight: typography.fontWeight.medium,
				}}
			>
				<span
					aria-hidden="true"
					css={{
						width: '0.5rem',
						height: '0.5rem',
						borderRadius: '999px',
						backgroundColor: color,
						flexShrink: 0,
					}}
				/>
				{label}
			</span>
			<span
				css={{
					fontSize: typography.fontSize.xl,
					fontWeight: typography.fontWeight.semibold,
					color: colors.text,
					lineHeight: 1.1,
					fontVariantNumeric: 'tabular-nums',
				}}
			>
				{value}
			</span>
			{sub ? (
				<span
					css={{
						fontSize: typography.fontSize.sm,
						color: colors.textMuted,
					}}
				>
					{sub}
				</span>
			) : null}
			{hasSparkline && sparkValues ? (
				<Sparkline id={id} color={color} values={sparkValues} />
			) : null}
		</div>
	)
}

function Sparkline({
	id,
	color,
	values,
}: {
	id: string
	color: string
	values: Array<number>
}) {
	const definition = useMemo(() => {
		const max = Math.max(1, ...values)
		// Preserve the original 44-unit strip: 7 above the peak, 5 below zero.
		const baseline = (-max * 5) / 32
		const rows = values.map((value, index) => ({ value, index }))
		return defineChart({
			gradients: [
				{
					id: 'spark',
					x1: 0,
					x2: 0,
					y1: 0,
					y2: 1,
					stops: [
						{ offset: 0, color, opacity: 0.25 },
						{ offset: 1, color, opacity: 0 },
					],
				},
			],
			marks: [
				decorative(
					areaY(rows, {
						x: 'index',
						y1: baseline,
						y2: 'value',
						fill: 'url(#spark)',
						fillOpacity: 1,
						curve: smoothCurve,
					}),
				),
				decorative(
					lineY(rows, {
						x: 'index',
						y: 'value',
						stroke: color,
						strokeWidth: 2,
						strokeOpacity: 0.85,
						curve: smoothCurve,
					}),
				),
				decorative(
					dot(rows.slice(-1), { x: 'index', y: 'value', r: 2.5, fill: color }),
				),
			],
			scales: {
				x: { scale: scaleLinear },
				y: { scale: scaleLinear().domain([baseline, (max * 39) / 32]) },
			},
			guides: false,
			margin: 0,
		})
	}, [color, values])

	return (
		<div
			aria-hidden="true"
			css={{
				position: 'absolute',
				insetInlineStart: 0,
				insetBlockEnd: 0,
				width: '100%',
				height: '2.25rem',
				pointerEvents: 'none',
			}}
		>
			<Chart
				definition={definition}
				height={36}
				initialWidth={220}
				idPrefix={id}
				ariaLabel="Trend"
				tabIndex={-1}
			/>
		</div>
	)
}
