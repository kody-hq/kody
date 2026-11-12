/** A stationary primary touch opens a menu, while scrolling and pinching cancel it. */
export function createTouchHold() {
	let pending: {
		pointer: number
		x: number
		y: number
		timer: ReturnType<typeof setTimeout>
	} | null = null
	function cancel() {
		if (pending) clearTimeout(pending.timer)
		pending = null
	}
	return {
		cancel,
		start(pointer: number, x: number, y: number, open: () => void) {
			cancel()
			pending = {
				pointer,
				x,
				y,
				timer: setTimeout(() => {
					pending = null
					open()
				}, 550),
			}
		},
		move(pointer: number, x: number, y: number) {
			if (
				pending &&
				(pending.pointer !== pointer ||
					Math.hypot(x - pending.x, y - pending.y) > 10)
			)
				cancel()
		},
	}
}
