/** @jsxImportSource @emotion/react */
import { publicAsset, publicAssetSrcSet } from '../public-assets.ts'
import { type CSSObject } from '@emotion/react'
import { type CSSProperties, type RefCallback } from 'react'
import { heroBaseImage } from '#universal/landing-images.ts'

/**
 * Layered mascot stage from the 2026 landing redesign: Kody stands still
 * holding the lantern while each prop drifts on its own clock, and the whole
 * field responds to the pointer with depth-weighted parallax. Used by the
 * landing hero and the login brand panel. Coordinates come straight from the
 * prototype markup (`landing/landing.html` / `landing/login.html`).
 *
 * Motion is enhance-only: prop entrances/drift are gated on `:root.js` and
 * `prefers-reduced-motion: no-preference`; parallax bails on touch and
 * reduced motion. The pattern/lantern backdrops stay with the callers , they
 * differ per surface.
 */

const motionOk = '@media (prefers-reduced-motion: no-preference)'

const stageProps = [
	{
		src: 'prop-1',
		w: 257,
		h: 231,
		tilt: true,
		depth: 0.9,
		vars: {
			'--x': '11.4%',
			'--y': '17.38%',
			'--w': '20.49%',
			'--dur': '8s',
			'--del': '-2s',
			'--in': '250ms',
		},
	},
	{
		src: 'prop-2',
		w: 48,
		h: 47,
		tilt: false,
		depth: 0.35,
		vars: {
			'--x': '13.32%',
			'--y': '47.93%',
			'--w': '3.83%',
			'--amt': '-14px',
			'--dur': '6s',
			'--del': '-1s',
			'--in': '320ms',
		},
	},
	{
		src: 'prop-3',
		w: 175,
		h: 177,
		tilt: false,
		depth: 0.7,
		vars: {
			'--x': '16.75%',
			'--y': '54.31%',
			'--w': '13.96%',
			'--dur': '9s',
			'--del': '-4s',
			'--in': '390ms',
		},
	},
	{
		src: 'prop-4',
		w: 108,
		h: 126,
		tilt: true,
		depth: 0.55,
		vars: {
			'--x': '22.25%',
			'--y': '36.52%',
			'--w': '8.61%',
			'--dur': '7s',
			'--del': '-3s',
			'--in': '460ms',
		},
	},
	{
		src: 'prop-5',
		w: 47,
		h: 47,
		tilt: false,
		depth: 0.4,
		vars: {
			'--x': '29.11%',
			'--y': '71.85%',
			'--w': '3.75%',
			'--amt': '-12px',
			'--dur': '5.5s',
			'--del': '-2.5s',
			'--in': '530ms',
		},
	},
	{
		src: 'prop-6',
		w: 41,
		h: 40,
		tilt: false,
		depth: 0.3,
		vars: {
			'--x': '67.46%',
			'--y': '36.68%',
			'--w': '3.27%',
			'--amt': '-13px',
			'--dur': '6.5s',
			'--del': '-5s',
			'--in': '600ms',
		},
	},
	{
		src: 'prop-7',
		w: 200,
		h: 201,
		tilt: true,
		depth: 0.85,
		vars: {
			'--x': '68.58%',
			'--y': '58.61%',
			'--w': '15.95%',
			'--dur': '8.5s',
			'--del': '-1.5s',
			'--in': '670ms',
		},
	},
	{
		src: 'prop-8',
		w: 153,
		h: 159,
		tilt: false,
		depth: 0.75,
		vars: {
			'--x': '72.01%',
			'--y': '40.35%',
			'--w': '12.2%',
			'--dur': '7.5s',
			'--del': '-6s',
			'--in': '740ms',
		},
	},
	{
		src: 'prop-9',
		w: 161,
		h: 156,
		tilt: false,
		depth: 0.8,
		vars: {
			'--x': '74.72%',
			'--y': '22.41%',
			'--w': '12.84%',
			'--dur': '9.5s',
			'--del': '-3.5s',
			'--in': '810ms',
		},
	},
] as const

/** Pointer parallax over the stage. Drift animations own `translate`;
 *  parallax composes through `transform`, so the two never fight. */
export const stageParallaxRef: RefCallback<HTMLDivElement> = (node) => {
	if (!node) return
	const controller = new AbortController()
	const { signal } = controller
	if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return
	if (matchMedia('(prefers-reduced-motion: reduce)').matches) return

	const layers = [...node.querySelectorAll<HTMLElement>('[data-depth]')].map(
		(el) => ({ el, depth: Number.parseFloat(el.dataset.depth ?? '0') }),
	)
	if (layers.length === 0) return

	const target = { x: 0, y: 0 }
	const current = { x: 0, y: 0 }
	let raf: number | null = null

	const tick = () => {
		current.x += (target.x - current.x) * 0.08
		current.y += (target.y - current.y) * 0.08
		for (const { el, depth } of layers) {
			el.style.transform = `translate3d(${(current.x * depth * 22).toFixed(2)}px, ${(current.y * depth * 14).toFixed(2)}px, 0)`
		}
		const settled =
			Math.abs(target.x - current.x) + Math.abs(target.y - current.y) <= 0.001
		if (settled) {
			current.x = target.x
			current.y = target.y
			raf = null
		} else {
			raf = requestAnimationFrame(tick)
		}
	}
	const wake = () => {
		if (raf == null) raf = requestAnimationFrame(tick)
	}

	const scope = node.closest('[data-parallax-scope]') ?? node
	scope.addEventListener(
		'pointermove',
		(event) => {
			if (!(event instanceof PointerEvent)) return
			const rect = node.getBoundingClientRect()
			target.x = Math.max(
				-1,
				Math.min(
					1,
					(event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2),
				),
			)
			target.y = Math.max(
				-1,
				Math.min(
					1,
					(event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2),
				),
			)
			wake()
		},
		{ signal },
	)
	scope.addEventListener(
		'pointerleave',
		() => {
			target.x = 0
			target.y = 0
			wake()
		},
		{ signal },
	)
	signal.addEventListener('abort', () => {
		if (raf != null) cancelAnimationFrame(raf)
	})
	return () => controller.abort()
}

export type HeroStageProps = {
	/** `landing` sizes itself to the hero width (640px); `auth` fills its
	 *  wrapper, which owns the login-panel sizing. */
	size: 'landing' | 'auth'
	/** Alt text for the base illustration; pass '' inside aria-hidden scenes. */
	alt: string
}

export function HeroStage(props: HeroStageProps) {
	return (
		<div
			css={props.size === 'auth' ? authStageCss : landingStageCss}
			ref={stageParallaxRef}
		>
			<img
				src={publicAsset(heroBaseImage.src)}
				srcSet={publicAssetSrcSet(heroBaseImage.srcSet)}
				sizes={heroBaseImage.sizes}
				width={heroBaseImage.width}
				height={heroBaseImage.height}
				fetchPriority="high"
				decoding="async"
				data-depth="-0.06"
				alt={props.alt}
				css={{ width: '100%', height: 'auto', display: 'block' }}
			/>
			{stageProps.map((prop) => (
				<img
					key={prop.src}
					src={publicAsset(`/images/hero/${prop.src}.webp`)}
					width={prop.w}
					height={prop.h}
					alt=""
					loading="lazy"
					decoding="async"
					data-depth={String(prop.depth)}
					style={prop.vars as CSSProperties}
					css={prop.tilt ? stagePropTiltCss : stagePropCss}
				/>
			))}
		</div>
	)
}

const stageBaseCss: CSSObject = {
	position: 'relative' as const,
	aspectRatio: '1',
	marginInline: 'auto',
	'@keyframes prop-in': {
		from: { opacity: 0 },
		to: { opacity: 1 },
	},
	'@keyframes prop-drift': {
		from: { translate: '0 0' },
		to: { translate: '0 var(--amt, -9px)' },
	},
	'@keyframes prop-drift-tilt': {
		from: { translate: '0 0', rotate: '0deg' },
		to: { translate: '0 var(--amt, -9px)', rotate: '2deg' },
	},
}

const landingStageCss: CSSObject = {
	...stageBaseCss,
	width: 'min(100%, 640px)',
}

/* The login panel's wrapper owns the stage width (440px, shrinking on short
   viewports) so its lantern glow stays aligned with the art. */
const authStageCss: CSSObject = {
	...stageBaseCss,
	width: '100%',
}

const stagePropBaseCss: CSSObject = {
	position: 'absolute' as const,
	left: 'var(--x)',
	top: 'var(--y)',
	width: 'var(--w)',
	height: 'auto',
}

/* Each prop drifts on its own period; negative delays desync the field.
   Entrance fade is staggered outward from Kody. Enhance-only. */
const stagePropCss: CSSObject = {
	...stagePropBaseCss,
	[motionOk]: {
		':root.js &': {
			animation:
				'prop-in 600ms var(--ease-out) var(--in, 300ms) both, prop-drift var(--dur, 7s) ease-in-out var(--del, 0s) infinite alternate',
		},
	},
}

const stagePropTiltCss: CSSObject = {
	...stagePropBaseCss,
	[motionOk]: {
		':root.js &': {
			animation:
				'prop-in 600ms var(--ease-out) var(--in, 300ms) both, prop-drift-tilt var(--dur, 7s) ease-in-out var(--del, 0s) infinite alternate',
		},
	},
}
