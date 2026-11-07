/** @jsxImportSource @emotion/react */
import { orgSlugFromPathname } from '#universal/org-pages.ts'
import {
	useCallback,
	useContext,
	useMemo,
	useState,
	type ReactNode,
} from 'react'
import { HotkeysProvider, useHotkey, useHotkeys } from '@tanstack/react-hotkeys'
import { useLocation, useRouter } from '@tanstack/react-router'
import { useShellData } from '../routes/__root.tsx'
import { commandHotkeys, navigationHotkeys } from './hotkeys.ts'
import { ShortcutProvider } from './shortcut-provider.tsx'
import { commandCatalog } from './catalog.ts'
import { toast } from '#client/toast.ts'
import { CommandContext } from './context.tsx'
import { CommandDialog } from './dialog.tsx'
import type { Command } from './model.ts'
import { renderIcon } from '../components/icon.tsx'
import { colors } from '#universal/styles/tokens.ts'

export function CommandProvider({ children }: { children: ReactNode }) {
	const { session } = useShellData()
	return (
		<ShortcutProvider
			key={session?.username ?? 'public'}
			actor={session?.username ?? 'public'}
		>
			<CommandController>{children}</CommandController>
		</ShortcutProvider>
	)
}
function CommandController({ children }: { children: ReactNode }) {
	const { session } = useShellData()
	const pathname = useLocation({ select: (location) => location.pathname })
	const [open, setOpen] = useState(false)
	const [registrations, setRegistrations] = useState<Record<string, Command[]>>(
		{},
	)
	const register = useCallback((id: string, commands: Command[]) => {
		setRegistrations((previous) => ({ ...previous, [id]: commands }))
		return () =>
			setRegistrations((previous) => {
				const next = { ...previous }
				delete next[id]
				return next
			})
	}, [])
	const context = useMemo(
		() => ({ open: () => setOpen(true), register }),
		[register],
	)
	useHotkey(commandHotkeys['commands.open'], () => setOpen((value) => !value), {
		requireReset: true,
		enabled: !open,
		ignoreInputs: 'auto',
	})
	const router = useRouter()
	const slug =
		session?.organizations.find(
			(org) => orgSlugFromPathname(pathname) === org.slug,
		)?.slug ?? session?.organizations.find((org) => org.personal)?.slug
	const catalog = commandCatalog(session, slug, pathname)
	useHotkeys(
		navigationHotkeys.map(([id, title]) => {
			const command = catalog.find(
				(item) => item.kind === 'page' && item.title === title,
			)
			return {
				hotkey: commandHotkeys[id],
				callback: () => {
					if (command?.href)
						void router
							.navigate({ href: command.href })
							.catch((error) => toast.error(String(error)))
				},
				options: { enabled: Boolean(command) && !open, ignoreInputs: true },
			}
		}),
	)
	return (
		<CommandContext value={context}>
			{children}
			{open ? (
				<HotkeysProvider scope="command-menu" exclusive>
					<CommandDialog
						key={JSON.stringify([
							session?.username,
							session?.organizations.map((org) => [org.slug, org.role]),
						])}
						session={session}
						pathname={pathname}
						pageCommands={Object.values(registrations).flat()}
						onClose={() => setOpen(false)}
					/>
				</HotkeysProvider>
			) : null}
		</CommandContext>
	)
}
export function CommandTrigger() {
	const context = useContext(CommandContext)
	if (!context) return null
	return (
		<button
			type="button"
			aria-label="Search and commands"
			title="Search and commands"
			onClick={context.open}
			css={{
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				flexShrink: 0,
				width: 36,
				height: 36,
				border: 0,
				borderRadius: 8,
				background: 'transparent',
				color: colors.text,
				opacity: 0.6,
				transition: 'opacity 120ms ease',
				cursor: 'pointer',
				'&:hover, &:focus-visible': { opacity: 1 },
				'&:focus-visible': {
					outline: `2px solid ${colors.primary}`,
					outlineOffset: -4,
				},
			}}
		>
			{renderIcon('search', { size: '18px' })}
		</button>
	)
}
