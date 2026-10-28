import { type ChartValue } from '@tanstack/charts'
import {
	Chart as RendererChart,
	type ChartProps,
} from '@tanstack/charts/react/core'
import { motion } from '@tanstack/charts/motion'

const renderer = motion({
	transition: { type: 'spring' },
	respectReducedMotion: true,
})

export function Chart<
	TDatum,
	TXValue extends ChartValue = ChartValue,
	TYValue extends ChartValue = ChartValue,
>(props: Omit<ChartProps<TDatum, TXValue, TYValue>, 'renderer'>) {
	return <RendererChart {...props} renderer={renderer} />
}
