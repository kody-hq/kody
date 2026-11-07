import { expect, test, vi } from 'vitest'
import { runCurrentPageCommand } from './context.tsx'
import type { Command } from './model.ts'

test('a confirmation cannot run a replacement action with the same id', () => {
	const pause = vi.fn()
	const resume = vi.fn()
	const expected: Command = {
		id: 'toggle-job:team:1',
		title: 'Pause Backup',
		kind: 'action',
		icon: 'pause',
		confirm: 'Pause scheduled runs?',
		run: pause,
	}
	const replacement = {
		...expected,
		title: 'Resume Backup',
		confirm: 'Resume scheduled runs?',
		run: resume,
	}
	expect(() => runCurrentPageCommand([replacement], expected)).toThrow(
		'Search again',
	)
	expect(resume).not.toHaveBeenCalled()
	expect(pause).not.toHaveBeenCalled()
	runCurrentPageCommand([{ ...expected, run: pause }], expected)
	expect(pause).toHaveBeenCalledOnce()
})
