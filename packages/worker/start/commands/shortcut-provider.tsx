import { useState, type ReactNode } from 'react'
import {
	HotkeysProvider,
	validateHotkey,
	type CustomHotkeys,
	type Hotkey,
} from '@tanstack/react-hotkeys'
import { z } from 'zod'
import { commandHotkeys } from './hotkeys.ts'
const hotkey = z.custom<Hotkey>(
	(value) =>
		(typeof value === 'string' ||
			(Array.isArray(value) &&
				value.every((item) => typeof item === 'string'))) &&
		validateHotkey(value).valid,
)
const savedSchema = z.record(z.string(), hotkey.nullable())
export function ShortcutProvider({
	actor,
	children,
}: {
	actor: string
	children: ReactNode
}) {
	const key = `kody:shortcuts:v1:${actor}`
	const [custom, setCustom] = useState<CustomHotkeys>(() => {
		try {
			const parsed = savedSchema.parse(
				JSON.parse(localStorage.getItem(key) ?? '{}'),
			)
			return Object.fromEntries(
				Object.entries(parsed).filter(([id]) => id in commandHotkeys),
			)
		} catch {
			return {}
		}
	})
	return (
		<HotkeysProvider
			appHotkeys={commandHotkeys}
			customHotkeys={custom}
			onCustomHotkeysChange={(next) => {
				setCustom(next)
				try {
					localStorage.setItem(key, JSON.stringify(next))
				} catch {
					/* Shortcuts still work for this session. */
				}
			}}
		>
			{children}
		</HotkeysProvider>
	)
}
