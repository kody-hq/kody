import { expect, test } from 'vitest'
import { nextChooserIndex } from './components/landing-hero-video.tsx'

test('nextChooserIndex moves along the strip, wraps at the ends, ignores other keys', () => {
	expect(nextChooserIndex(0, 'ArrowRight', 3)).toBe(1)
	expect(nextChooserIndex(0, 'ArrowDown', 3)).toBe(1)
	expect(nextChooserIndex(2, 'ArrowRight', 3)).toBe(0)
	expect(nextChooserIndex(1, 'ArrowLeft', 3)).toBe(0)
	expect(nextChooserIndex(1, 'ArrowUp', 3)).toBe(0)
	expect(nextChooserIndex(0, 'ArrowLeft', 3)).toBe(2)
	expect(nextChooserIndex(1, 'Home', 3)).toBe(0)
	expect(nextChooserIndex(1, 'End', 3)).toBe(2)
	expect(nextChooserIndex(1, 'Enter', 3)).toBeNull()
	expect(nextChooserIndex(1, 'a', 3)).toBeNull()
	expect(nextChooserIndex(0, 'ArrowRight', 0)).toBeNull()
})
