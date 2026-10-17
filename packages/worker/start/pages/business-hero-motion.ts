// All art, anchors, and connectors share one SVG coordinate system.
// Each path follows the same offset as the artwork it connects to.
export function businessCloudMotion(root: Element, signal: AbortSignal) {
	const stage = root.querySelector<SVGSVGElement>('#cloud-stage')
	const toggleElement = root.querySelector<HTMLButtonElement>(
		'#toggle-cloud-motion',
	)
	if (!stage || !toggleElement) return
	const toggle = toggleElement
	const reduced = matchMedia('(prefers-reduced-motion: reduce)')
	const nodes = [
		{ id: 'mascot', amplitude: 0, phase: 0 },
		{ id: 'cloud', amplitude: 7, phase: 0.8 },
		{ id: 'workspace-top', amplitude: 12, phase: 2.1 },
		{ id: 'workspace-bottom', amplitude: 9, phase: 4.2 },
		{ id: 'workspace-right', amplitude: 11, phase: 5.6 },
	].map((node) => ({
		...node,
		element: stage.querySelector<SVGGElement>(`#${node.id}`)!,
		x: 0,
		y: 0,
	}))
	const links = [
		{
			node: 0,
			start: [755, 418] as const,
			end: [475, 490] as const,
			bend: -45,
		},
		{
			node: 2,
			start: [1000, 360] as const,
			end: [1165, 300] as const,
			bend: -25,
		},
		{
			node: 3,
			start: [837, 440] as const,
			end: [895, 754] as const,
			bend: 70,
		},
		{
			node: 4,
			start: [940, 425] as const,
			end: [1175, 650] as const,
			bend: 30,
		},
	].map((link, index) => ({
		...link,
		paths: stage.querySelectorAll<SVGPathElement>(`[data-link="${index}"]`),
		lights: stage.querySelectorAll<SVGCircleElement>(`[data-light="${index}"]`),
	}))
	let userPaused = false
	let visible = false
	let frame = 0
	let previous: number | null = null
	let elapsed = 0

	function paint(time: number) {
		nodes.forEach((node) => {
			node.x = Math.sin(time * 0.32 + node.phase) * node.amplitude * 0.4
			node.y = Math.sin(time * 0.48 + node.phase) * node.amplitude
			node.element.setAttribute('transform', `translate(${node.x} ${node.y})`)
		})
		links.forEach((link, index) => {
			const cloud = nodes[1]!
			const target = nodes[link.node]!
			const a = [link.start[0] + cloud.x, link.start[1] + cloud.y] as const
			const d = [link.end[0] + target.x, link.end[1] + target.y] as const
			const b = [a[0], a[1] + (d[1] - a[1]) * 0.6 + link.bend] as const
			const c = [d[0], d[1] - (d[1] - a[1]) * 0.6 + link.bend] as const
			const path = `M ${a} C ${b} ${c} ${d}`
			link.paths.forEach((element) => element.setAttribute('d', path))
			link.lights.forEach((light, i) => {
				const t = (time * 0.14 + index * 0.21 + i * 0.5) % 1
				const u = 1 - t
				const point = (axis: 0 | 1) =>
					u ** 3 * a[axis] +
					3 * u ** 2 * t * b[axis] +
					3 * u * t ** 2 * c[axis] +
					t ** 3 * d[axis]
				light.setAttribute('cx', String(point(0)))
				light.setAttribute('cy', String(point(1)))
				light.setAttribute('opacity', String(Math.min(1, t * 8, (1 - t) * 8)))
			})
		})
	}
	function tick(now: number) {
		if (previous !== null) elapsed += Math.min((now - previous) / 1000, 0.05)
		previous = now
		paint(elapsed)
		frame = requestAnimationFrame(tick)
	}
	function sync() {
		cancelAnimationFrame(frame)
		previous = null
		const paused = userPaused || reduced.matches
		toggle.hidden = reduced.matches
		toggle.textContent = paused ? 'Play animation' : 'Pause animation'
		if (!paused && visible && !document.hidden)
			frame = requestAnimationFrame(tick)
	}
	toggle.addEventListener(
		'click',
		() => {
			userPaused = !userPaused
			sync()
		},
		{ signal },
	)
	reduced.addEventListener('change', sync, { signal })
	document.addEventListener('visibilitychange', sync, { signal })
	const observer = new IntersectionObserver(([entry]) => {
		visible = entry?.isIntersecting ?? false
		sync()
	})
	observer.observe(stage)
	signal.addEventListener(
		'abort',
		() => {
			observer.disconnect()
			cancelAnimationFrame(frame)
		},
		{ once: true },
	)
	paint(0)
	sync()
}
