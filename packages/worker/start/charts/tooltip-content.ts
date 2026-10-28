import { type ChartPoint, type ChartValue } from '@tanstack/charts'
import { type ChartTooltipContentContext } from '@tanstack/charts/tooltip'

export function tooltipRows<T, X extends ChartValue, Y extends ChartValue>(
	points: readonly ChartPoint<T, X, Y>[],
	context: ChartTooltipContentContext,
	describe: (datum: T) => { label: string; value: string },
	title?: string,
) {
	return {
		title,
		rows: points.map((point) => ({
			...describe(point.datum),
			color: point.color,
			active:
				point.key === context.primaryPoint?.key &&
				point.markId === context.primaryPoint?.markId,
		})),
	}
}
