import { useEffect, useRef } from 'react'

/**
 * Primitive widgets animate with CSS only. This hook decides when:
 * `data-motion` lands the first time a widget scrolls into view and
 * `data-paused` holds the loop while it is off screen, so a page of widgets
 * costs nothing until someone looks at one. Reduced motion never sets
 * `data-motion`, and the server-rendered still stays the whole widget.
 */

type Watcher = (visible: boolean) => void

const watchers = new WeakMap<Element, Watcher>()
let sharedObserver: IntersectionObserver | null = null

function getObserver() {
	sharedObserver ??= new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				watchers.get(entry.target)?.(entry.isIntersecting)
			}
		},
		{ threshold: 0.25 },
	)
	return sharedObserver
}

export function usePrimitiveWidgetMotion() {
	const ref = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const node = ref.current
		const controller = new AbortController()
		const { signal } = controller
		if (!(node instanceof HTMLElement)) return
		if (typeof IntersectionObserver === 'undefined') return
		const motionOk = matchMedia('(prefers-reduced-motion: no-preference)')
		let visible = false

		const apply = () => {
			if (!motionOk.matches) {
				delete node.dataset.motion
				delete node.dataset.paused
				return
			}
			if (visible) {
				node.dataset.motion = ''
				delete node.dataset.paused
			} else if ('motion' in node.dataset) {
				node.dataset.paused = ''
			}
		}

		watchers.set(node, (next) => {
			visible = next
			apply()
		})
		const observer = getObserver()
		observer.observe(node)
		motionOk.addEventListener('change', apply, { signal })
		signal.addEventListener('abort', () => {
			observer.unobserve(node)
			watchers.delete(node)
		})
		return () => {
			controller.abort()
		}
	}, [])
	return ref
}
