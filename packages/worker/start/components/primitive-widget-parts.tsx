/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { type ReactNode, type CSSProperties } from 'react'
import { usePrimitiveWidgetMotion } from './primitive-widget-motion.ts'
import { type PrimitiveWidgetId } from '#universal/primitive-cards.ts'

type PrimitiveWidgetSize = 'full' | 'mini'

export function PrimitiveWidgetFrame({
	id,
	size,
	height,
	className,
	stack,
	children,
}: {
	id: PrimitiveWidgetId
	size: PrimitiveWidgetSize
	height?: number
	className?: string
	stack?: boolean
	children?: ReactNode
}) {
	const motion = usePrimitiveWidgetMotion()
	return (
		<div
			className={className ? `pw pw-${id} ${className}` : `pw pw-${id}`}
			data-size={size}
			aria-hidden={size === 'mini' ? 'true' : undefined}
			style={
				{
					'--pw-accent': `var(--primitive-${id})`,
					...(height ? { '--pw-ratio': `360 / ${height}` } : {}),
				} as CSSProperties
			}
			ref={motion}
		>
			<div className="pw-stage" data-stack={stack ? '' : undefined}>
				{children}
			</div>
		</div>
	)
}

export function at(x: number, y: number, extra?: Record<string, string>) {
	return { left: `${x}%`, top: `${y}%`, ...extra }
}

export function icon(name: string) {
	return (
		<span
			className="pw-icon"
			aria-hidden="true"
			style={
				{
					'--pw-icon': `url("${publicAsset(`/images/icons/${name}.svg`)}")`,
				} as CSSProperties
			}
		></span>
	)
}

export function wires(children: ReactNode, height = 200) {
	return (
		<svg
			className="pw-wires"
			viewBox={`0 0 360 ${height}`}
			aria-hidden="true"
			focusable={false}
		>
			{children}
		</svg>
	)
}

/** One wire: the resting line, the looping pulse, and a one-shot pulse
 *  keyed by `shot` so a click replays it. */
export function wire(options: {
	d: string
	i?: number
	on?: boolean
	shot?: number
	key?: string
}) {
	const { d, i = 0, on: lit = false, shot = 0, key } = options
	return (
		<g
			key={key}
			className="pw-wire"
			data-on={lit ? '' : undefined}
			style={{ '--i': String(i) } as CSSProperties}
		>
			<path className="pw-line" d={d} />
			<path className="pw-pulse" d={d} pathLength="100" />
			{shot > 0 ? (
				<path key={`shot-${shot}`} className="pw-shot" d={d} pathLength="100" />
			) : null}
		</g>
	)
}

export function choice(options: {
	key: string
	class: string
	selected: boolean
	onPick?: () => void
	style?: Record<string, string>
	label?: string
	children: ReactNode
}) {
	const {
		key,
		class: className,
		selected,
		onPick,
		style,
		label,
		children,
	} = options
	if (!onPick) {
		return (
			<span
				key={key}
				className={className}
				data-on={selected ? '' : undefined}
				style={style}
			>
				{children}
			</span>
		)
	}
	return (
		<button
			type="button"
			key={key}
			className={className}
			aria-pressed={selected ? 'true' : 'false'}
			aria-label={label}
			style={style}
			onClick={onPick}
		>
			{children}
		</button>
	)
}
