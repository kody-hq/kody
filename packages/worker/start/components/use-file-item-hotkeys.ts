import type { RefObject } from 'react'
import { useHotkeys } from '@tanstack/react-hotkeys'

export function useFileItemHotkeys({
	target,
	onOpen,
	onRename,
}: {
	target: RefObject<HTMLElement | null>
	onOpen: (id: string) => void
	onRename: (id: string) => void
}) {
	function act(event: KeyboardEvent, action: (id: string) => void) {
		if (
			(event.target as Element).closest(
				'input, textarea, select, [contenteditable]:not([contenteditable=false])',
			)
		)
			return
		const item = (event.target as Element).closest<HTMLElement>(
			'[data-browser-item]',
		)
		const id = item?.dataset.browserItem
		if (!id || !target.current?.contains(item)) return
		event.preventDefault()
		action(id)
	}
	useHotkeys(
		[
			{ hotkey: 'Space', callback: (event) => act(event, onOpen) },
			{ hotkey: 'Mod+O', callback: (event) => act(event, onOpen) },
			{ hotkey: 'Mod+ArrowDown', callback: (event) => act(event, onOpen) },
			{ hotkey: 'Enter', callback: (event) => act(event, onRename) },
		],
		{
			target,
			ignoreInputs: false,
			ignoreDefaultPrevented: true,
			preventDefault: false,
		},
	)
}
