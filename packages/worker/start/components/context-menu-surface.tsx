/** @jsxImportSource @emotion/react */
import {
	createContext,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
	type DragEventHandler,
} from 'react'
import { createTouchHold } from './touch-hold.ts'
import { colors } from '#universal/styles/tokens.ts'
import { Menu } from '@base-ui/react/menu'
import {
	overlayItemCss,
	overlayPopupCss,
	overlayPositionerCss,
} from './overlay-styles.ts'

export type ContextAction = {
	id: string
	label: string
	run: () => void | Promise<void>
	disabled?: boolean
	danger?: boolean
}

const ContextMenuOpener = createContext<
	((target: HTMLButtonElement) => void) | null
>(null)

export function ContextMenuButton({
	label,
	children,
	className,
	disabled,
	onDragStart,
	onDragEnd,
}: {
	label: string
	children: ReactNode
	className?: string
	disabled?: boolean
	onDragStart?: DragEventHandler<HTMLButtonElement>
	onDragEnd?: DragEventHandler<HTMLButtonElement>
}) {
	const open = useContext(ContextMenuOpener)
	return (
		<button
			type="button"
			disabled={disabled}
			className={className}
			aria-label={label}
			title={label}
			aria-haspopup="menu"
			draggable={Boolean(onDragStart)}
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			onClick={(event) => open?.(event.currentTarget)}
		>
			{children}
		</button>
	)
}

/** Shared mouse, touch, and keyboard invocation. Editable fields retain native menus. */
export function ContextMenuSurface({
	children,
	resolve,
	allowTextEditing = false,
}: {
	children: ReactNode
	allowTextEditing?: boolean
	resolve: (
		target: Element,
		point?: { x: number; y: number },
	) => ContextAction[] | undefined
}) {
	const trigger = useRef<HTMLElement | null>(null)
	const [hold] = useState(createTouchHold)
	const suppressClick = useRef<{ until: number; target: Element } | null>(null)
	const [open, setOpen] = useState<{
		anchor: { getBoundingClientRect: () => DOMRect }
		container: HTMLElement | null
		actions: ContextAction[]
	} | null>(null)
	useEffect(() => hold.cancel, [hold])
	function actionsAt(
		target: EventTarget | null,
		fromContextMenu = false,
		point?: { x: number; y: number },
	) {
		if (
			!(target instanceof Element) ||
			target.closest('input, select, [role="menu"]')
		)
			return
		if (
			!(fromContextMenu && allowTextEditing) &&
			target.closest('textarea, [contenteditable="true"]')
		)
			return
		const actions = resolve(target, point)
		return actions?.length ? actions : undefined
	}
	function show(
		target: Element,
		x: number,
		y: number,
		actions: ContextAction[],
	) {
		trigger.current =
			target.closest<HTMLElement>('a, button, [tabindex]') ?? null
		setOpen({
			anchor: { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) },
			container: target.closest<HTMLElement>('dialog, [popover], :fullscreen'),
			actions,
		})
	}
	return (
		<ContextMenuOpener
			value={(target) => {
				const actions = resolve(target)
				if (!actions?.length) return
				const box = target.getBoundingClientRect()
				show(target, box.left, box.bottom + 4, actions)
			}}
		>
			<div
				css={{
					display: 'contents',
					'& [data-workspace-item], & [data-page-block-id]': {
						WebkitTouchCallout: 'none',
					},
					'& input, & textarea, & select, & [contenteditable="true"]': {
						WebkitTouchCallout: 'default',
					},
				}}
				onContextMenu={(event) => {
					const actions = actionsAt(event.target, true, {
						x: event.clientX,
						y: event.clientY,
					})
					if (!actions) return
					event.preventDefault()
					event.stopPropagation()
					hold.cancel()
					show(event.target as Element, event.clientX, event.clientY, actions)
				}}
				onKeyDown={(event) => {
					if (
						event.key !== 'ContextMenu' &&
						!(event.shiftKey && event.key === 'F10')
					)
						return
					const actions = actionsAt(event.target, true)
					if (!actions) return
					event.preventDefault()
					event.stopPropagation()
					const box = (event.target as Element).getBoundingClientRect()
					show(event.target as Element, box.left, box.bottom, actions)
				}}
				onPointerDown={(event) => {
					if (event.pointerType !== 'touch') return
					hold.cancel()
					if (!event.isPrimary) return
					const actions = actionsAt(event.target, false, {
						x: event.clientX,
						y: event.clientY,
					})
					if (!actions) return
					event.stopPropagation()
					const target = event.target as Element
					const { pointerId, clientX: x, clientY: y } = event
					hold.start(pointerId, x, y, () => {
						suppressClick.current = { until: Date.now() + 1000, target }
						show(target, x, y, actions)
					})
				}}
				onPointerMove={(event) =>
					hold.move(event.pointerId, event.clientX, event.clientY)
				}
				onPointerUp={hold.cancel}
				onPointerCancel={hold.cancel}
				onClickCapture={(event) => {
					const pending = suppressClick.current
					const target = event.target as Element
					if (
						pending &&
						pending.until > Date.now() &&
						(pending.target.contains(target) ||
							target.contains(pending.target)) &&
						!target.closest('[role="menu"]')
					) {
						event.preventDefault()
						event.stopPropagation()
						suppressClick.current = null
					}
				}}
			>
				{children}
				<Menu.Root
					modal={false}
					open={!!open}
					onOpenChange={(next) => {
						if (!next) setOpen(null)
					}}
				>
					<Menu.Portal container={open?.container ?? undefined}>
						<Menu.Positioner
							anchor={open?.anchor}
							align="start"
							css={overlayPositionerCss}
						>
							<Menu.Popup
								aria-label="Context actions"
								finalFocus={(type) =>
									type === 'keyboard' ? trigger.current : false
								}
								css={{ ...overlayPopupCss, minWidth: 180 }}
							>
								{open?.actions.map((action) => (
									<Menu.Item
										key={action.id}
										disabled={action.disabled}
										css={{
											...overlayItemCss,
											minHeight: 32,
											color: action.danger ? colors.danger : colors.text,
											'@media (pointer: coarse)': { minHeight: 44 },
										}}
										onClick={() => void action.run()}
									>
										{action.label}
									</Menu.Item>
								))}
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>
			</div>
		</ContextMenuOpener>
	)
}
