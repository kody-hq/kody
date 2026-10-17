/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { useEffect, useRef } from 'react'
import { businessCloudMotion } from './business-hero-motion.ts'
export function BusinessHero() {
	const root = useRef<HTMLElement>(null)
	useEffect(() => {
		if (!root.current) return
		const controller = new AbortController()
		businessCloudMotion(root.current, controller.signal)
		return () => controller.abort()
	}, [])
	return (
		<figure className="hero-art" ref={root}>
			<svg
				id="cloud-stage"
				viewBox="0 0 1536 1024"
				role="img"
				aria-labelledby="cloud-art-title"
			>
				<title id="cloud-art-title">
					Kody connects separate team workspaces through a shared cloud.
				</title>
				<defs>
					<clipPath id="clip-mascot">
						<polygon points="110,0 685,0 685,265 625,325 625,625 575,700 575,830 640,985 110,985" />
					</clipPath>
					<clipPath id="clip-cloud">
						<polygon points="625,170 1070,170 1070,500 625,500" />
					</clipPath>
					<clipPath id="clip-workspace-top">
						<polygon points="1080,150 1520,150 1520,490 1080,490" />
					</clipPath>
					<clipPath id="clip-workspace-bottom">
						<polygon points="620,615 1040,615 1040,990 640,990 580,830 580,760" />
					</clipPath>
					<clipPath id="clip-workspace-right">
						<polygon points="1070,510 1520,510 1520,870 1070,870" />
					</clipPath>
				</defs>
				<g fill="none" strokeLinecap="round" aria-hidden="true">
					<path
						data-link="0"
						d="M 755,418 C 755,416 475,402 475,490"
						stroke="#c59c50"
						strokeOpacity=".35"
						strokeWidth="5"
					/>
					<path
						data-link="0"
						d="M 755,418 C 755,416 475,402 475,490"
						stroke="#edca78"
						strokeWidth="2"
					/>
					<path
						data-link="1"
						d="M 1000,360 C 1000,299 1165,311 1165,300"
						stroke="#c59c50"
						strokeOpacity=".35"
						strokeWidth="5"
					/>
					<path
						data-link="1"
						d="M 1000,360 C 1000,299 1165,311 1165,300"
						stroke="#edca78"
						strokeWidth="2"
					/>
					<path
						data-link="2"
						d="M 837,440 C 837,698 895,636 895,754"
						stroke="#c59c50"
						strokeOpacity=".35"
						strokeWidth="5"
					/>
					<path
						data-link="2"
						d="M 837,440 C 837,698 895,636 895,754"
						stroke="#edca78"
						strokeWidth="2"
					/>
					<path
						data-link="3"
						d="M 940,425 C 940,590 1175,545 1175,650"
						stroke="#c59c50"
						strokeOpacity=".35"
						strokeWidth="5"
					/>
					<path
						data-link="3"
						d="M 940,425 C 940,590 1175,545 1175,650"
						stroke="#edca78"
						strokeWidth="2"
					/>
				</g>
				<g aria-hidden="true" fill="#ffe7a4">
					<circle data-light="0" r="6" opacity="0" />
					<circle data-light="0" r="6" opacity="0" />
					<circle data-light="1" r="6" opacity="0" />
					<circle data-light="1" r="6" opacity="0" />
					<circle data-light="2" r="6" opacity="0" />
					<circle data-light="2" r="6" opacity="0" />
					<circle data-light="3" r="6" opacity="0" />
					<circle data-light="3" r="6" opacity="0" />
				</g>
				<g id="mascot" aria-hidden="true">
					<image
						href={publicAsset('/images/business/agent-cloud-pieces.webp')}
						width="1536"
						height="1024"
						clipPath="url(#clip-mascot)"
					/>
				</g>
				<g id="cloud" aria-hidden="true">
					<image
						href={publicAsset('/images/business/agent-cloud-pieces.webp')}
						width="1536"
						height="1024"
						clipPath="url(#clip-cloud)"
					/>
				</g>
				<g id="workspace-top" aria-hidden="true">
					<image
						href={publicAsset('/images/business/agent-cloud-pieces.webp')}
						width="1536"
						height="1024"
						clipPath="url(#clip-workspace-top)"
					/>
				</g>
				<g id="workspace-bottom" aria-hidden="true">
					<image
						href={publicAsset('/images/business/agent-cloud-pieces.webp')}
						width="1536"
						height="1024"
						clipPath="url(#clip-workspace-bottom)"
					/>
				</g>
				<g id="workspace-right" aria-hidden="true">
					<image
						href={publicAsset('/images/business/agent-cloud-pieces.webp')}
						width="1536"
						height="1024"
						clipPath="url(#clip-workspace-right)"
					/>
				</g>
			</svg>
			<button id="toggle-cloud-motion" type="button" hidden>
				Pause animation
			</button>
		</figure>
	)
}
