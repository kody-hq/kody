/** @jsxImportSource @emotion/react */
import { publicAsset, publicAssetSrcSet } from '../public-assets.ts'
import { useEffect, useEffectEvent, useRef, type CSSProperties } from 'react'
import {
	attachLanternOrbMotion,
	lanternOrbReleaseEvent,
} from './landing-lantern-motion.ts'
import {
	landingHomePrimitives,
	type LandingHomePrimitive,
} from '#universal/landing-home-copy.ts'
import {
	landingLanternImage,
	landingLanternOrbArt,
	landingLanternOrbClipPath,
	landingLanternOrbs,
	landingPrimitiveColorVar,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'

/**
 * Five-orb lantern beside the primitives sentence. The lantern still is one
 * image. Each orb sits in an overlay clipped to the opening inside the
 * frame, centered on its hotspot, so the highlight ring, the disc, and the
 * leader rim share one centre while the button moves.
 */

/** Hover opens for mice and pens only. A touch tap fires synthetic enter
 *  and leave events around its click, which would close what the tap just
 *  opened, so touch pointers are ignored here and handled by click. */
function hoverPointer(event: { pointerType: string }) {
	return event.pointerType !== 'touch'
}

function primitiveById(id: LandingPrimitiveId): LandingHomePrimitive {
	return landingHomePrimitives.find((primitive) => primitive.id === id)!
}

export type LandingLanternProps = {
	activeId: LandingPrimitiveId | null
	onOpen: (id: LandingPrimitiveId) => void
	onToggle: (id: LandingPrimitiveId) => void
	onClose: (id: LandingPrimitiveId) => void
	onDismiss: (id: LandingPrimitiveId) => void
	onResume: (id: LandingPrimitiveId) => void
	/** Hero reuse: same physics and layers, no disclosures. */
	decorative?: boolean
}

export function LandingLantern(props: LandingLanternProps) {
	const node = useRef<HTMLElement>(null)
	const release = useEffectEvent((event: Event) => {
		const target = event.target
		if (!(target instanceof HTMLElement)) return
		const id = target.dataset.orb
		const orb = landingLanternOrbs.find((orb) => orb.id === id)
		if (orb) leave(orb.id)
	})
	useEffect(() => {
		if (!node.current) return
		const controller = new AbortController()
		attachLanternOrbMotion(node.current, controller.signal)
		node.current.addEventListener(lanternOrbReleaseEvent, release, {
			signal: controller.signal,
		})
		return () => controller.abort()
	}, [])

	function leave(id: LandingPrimitiveId) {
		props.onClose(id)
		props.onResume(id)
	}

	const { activeId, onOpen, onToggle, onDismiss, decorative } = props
	return (
		<figure
			className="landing-lantern"
			data-decorative={decorative ? '' : undefined}
			ref={node}
		>
			<figcaption className="visually-hidden">
				A lantern holding five glowing orbs, one for each Kody primitive.
			</figcaption>
			<img
				src={publicAsset(landingLanternImage.src)}
				srcSet={publicAssetSrcSet(landingLanternImage.srcSet)}
				sizes={landingLanternImage.sizes}
				width={landingLanternImage.width}
				height={landingLanternImage.height}
				decoding="async"
				alt=""
				className="landing-lantern-art"
			/>
			<div
				className="landing-lantern-orbs"
				style={{ clipPath: landingLanternOrbClipPath() }}
			>
				{landingLanternOrbs.map((orb) => {
					const primitive = primitiveById(orb.id)
					const open = activeId === orb.id
					const art = (
						<img
							src={publicAsset(landingLanternOrbArt[orb.id])}
							alt=""
							decoding="async"
							draggable="false"
							className="landing-lantern-orb-art"
							data-orb-art={orb.id}
							data-open={open ? '' : undefined}
						/>
					)
					// Unitless shares of lantern width. Percentages make
					// `calc(100% * var(--art) / var(--size))` invalid in Firefox.
					const pose: CSSProperties & Record<`--${string}`, string> = {
						'--x': `${orb.x}%`,
						'--y': `${orb.y}%`,
						'--size': `${orb.size}`,
						'--art': `${orb.art}`,
						'--primitive-color': landingPrimitiveColorVar(orb.id),
					}
					if (decorative) {
						return (
							<span
								key={orb.id}
								className="landing-lantern-orb"
								data-orb={orb.id}
								style={pose}
								aria-hidden="true"
							>
								{art}
							</span>
						)
					}
					return (
						<button
							key={orb.id}
							type="button"
							className="landing-lantern-orb"
							data-orb={orb.id}
							data-open={open ? '' : undefined}
							style={pose}
							aria-label={`${primitive.word} primitive`}
							onPointerEnter={(event) => {
								if (!hoverPointer(event)) return
								const current = event.currentTarget
								// A toss can slide back under a still pointer.
								// That is not a new hover, so the word stays shut.
								if (
									current instanceof HTMLElement &&
									current.dataset.suppressHover != null
								) {
									return
								}
								onOpen(orb.id)
							}}
							onPointerLeave={(event) => {
								if (!hoverPointer(event)) return
								// A captured drag leaves the hotspot without
								// ending the grab. The release event closes it.
								const current = event.currentTarget
								if (
									current instanceof Element &&
									current.hasPointerCapture(event.pointerId)
								) {
									return
								}
								leave(orb.id)
							}}
							onFocus={() => onOpen(orb.id)}
							onBlur={() => leave(orb.id)}
							onClick={() => onToggle(orb.id)}
							onKeyDown={(event) => {
								if (event.key !== 'Escape') return
								event.preventDefault()
								onDismiss(orb.id)
							}}
						>
							{art}
						</button>
					)
				})}
			</div>
		</figure>
	)
}
