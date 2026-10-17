import { type RefCallback } from 'react'

type RevealKind = 'reveal' | 'reveal-pop' | 'reveal-card'
let observer: IntersectionObserver | null = null

/** Add motion only after mount, so server HTML remains visible without JS. */
export function revealRef(
	delayMs = 0,
	kind: RevealKind = 'reveal',
): RefCallback<HTMLElement> {
	return (node) => {
		if (!node || typeof IntersectionObserver === 'undefined') return
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
		if (delayMs > 0) node.style.setProperty('--reveal-delay', `${delayMs}ms`)
		node.classList.add(kind)
		const rect = node.getBoundingClientRect()
		if (rect.bottom > 0 && rect.top < window.innerHeight) {
			node.classList.add('in')
			return
		}
		observer ??= new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue
					entry.target.classList.add('in')
					observer?.unobserve(entry.target)
				}
			},
			{ rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
		)
		observer.observe(node)
		return () => observer?.unobserve(node)
	}
}
