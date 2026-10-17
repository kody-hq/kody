/** @jsxImportSource @emotion/react */

import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	buildSmoothAreaPath,
	buildSmoothLinePath,
	type ChartPoint,
} from '#client/charts/chart-geometry.ts'
import { softColor } from '#client/charts/chart-theme.ts'

type StatCardProps = {
	/** Unique id prefix for the sparkline gradient. */
	id: string
	label: string
	value: string
	sub?: string
	color: string
	/** Optional small trend line rendered along the card bottom. */
	sparkValues?: Array<number>
}

const sparkWidth = 220
const sparkHeight = 44

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
				borderRadius: radius.lg,
				border: `1px solid ${colors.border}`,
				backgroundColor: colors.surface,
				backgroundImage: `linear-gradient(140deg, ${softColor(color, 10)}, transparent 55%)`,
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
			{hasSparkline && sparkValues
				? renderSparkline(id, color, sparkValues)
				: null}
		</div>
	)
}

function renderSparkline(id: string, color: string, values: Array<number>) {
	const maxValue = Math.max(1, ...values)
	const points = values.map((value, index): ChartPoint => ({
		x: (sparkWidth * index) / (values.length - 1),
		y: sparkHeight - 5 - (sparkHeight - 12) * (value / maxValue),
	}))
	const lastPoint = points[points.length - 1]
	return (
		<svg
			viewBox={`0 0 ${sparkWidth} ${sparkHeight}`}
			aria-hidden="true"
			preserveAspectRatio="none"
			css={{
				position: 'absolute',
				insetInlineStart: 0,
				insetBlockEnd: 0,
				width: '100%',
				height: '2.25rem',
				display: 'block',
				pointerEvents: 'none',
			}}
		>
			<defs>
				<linearGradient id={`${id}-spark`} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor={color} stopOpacity="0.25" />
					<stop offset="100%" stopColor={color} stopOpacity="0" />
				</linearGradient>
			</defs>
			<path
				d={buildSmoothAreaPath(points, sparkHeight)}
				fill={`url(#${id}-spark)`}
			/>
			<path
				d={buildSmoothLinePath(points)}
				fill="none"
				stroke={color}
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				opacity="0.85"
			/>
			{lastPoint ? (
				<circle cx={lastPoint.x} cy={lastPoint.y} r="2.5" fill={color} />
			) : null}
		</svg>
	)
}
