import { createContext, useContext, useEffect, useId, useRef } from 'react'
import type { Command } from './model.ts'

export const CommandContext = createContext<{
	open: () => void
	register: (id: string, commands: Command[]) => () => void
} | null>(null)

/** Page actions use the same mutation and settlement as their visible controls. */
export function usePageCommands(commands: Command[]) {
	const context = useContext(CommandContext)
	const id = useId()
	const latest = useRef(commands)
	useEffect(() => {
		latest.current = commands
	})
	const signature = JSON.stringify(
		commands.map(({ run: _run, ...command }) => command),
	)
	useEffect(() => {
		if (!context) return
		return context.register(
			id,
			latest.current.map((command) => ({
				...command,
				context: true,
				run: command.run
					? () => runCurrentPageCommand(latest.current, command)
					: undefined,
			})),
		)
	}, [context, id, signature])
}

function commandMetadata({ run: _run, ...command }: Command) {
	return JSON.stringify(command)
}

export function runCurrentPageCommand(commands: Command[], expected: Command) {
	const current = commands.find((command) => command.id === expected.id)
	if (!current?.run || commandMetadata(current) !== commandMetadata(expected))
		throw new Error('This action is no longer available. Search again.')
	return current.run()
}
