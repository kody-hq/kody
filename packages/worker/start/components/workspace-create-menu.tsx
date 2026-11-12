/** @jsxImportSource @emotion/react */
import { lazy, Suspense, useState } from 'react'
import { LoadingIndicator } from './loading-indicator.tsx'
const FileStorageSettings = lazy(
	() => import('../pages/file-storage-settings.tsx'),
)
import { SiteLink } from './site-link.tsx'
import { Menu } from '@base-ui/react/menu'
import {
	overlayItemCss,
	overlayPopupCss,
	overlayPositionerCss,
} from './overlay-styles.ts'
import { colors } from '#universal/styles/tokens.ts'
export function WorkspaceCreateMenu({
	orgSlug,
	parentId,
	disabled,
	onUpload,
	canManageStorage = false,
}: {
	orgSlug: string
	parentId?: string
	disabled?: boolean
	onUpload: () => void
	canManageStorage?: boolean
}) {
	const [storageOpen, setStorageOpen] = useState(false)
	return (
		<>
			<Menu.Root modal={false}>
				<Menu.Trigger
					css={{
						display: 'grid',
						placeItems: 'center',
						width: 28,
						height: 28,
						padding: 0,
						border: 0,
						borderRadius: 4,
						background: 'transparent',
						color: colors.textMuted,
						cursor: 'pointer',
						'&:hover': { background: colors.borderSubtle },
					}}
					aria-label="Create"
					title="Create"
					disabled={disabled}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.3"
					>
						<path d="M8 2v12M2 8h12" />
					</svg>
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Positioner
						align="start"
						sideOffset={4}
						css={overlayPositionerCss}
					>
						<Menu.Popup
							aria-label="Create item"
							css={{ ...overlayPopupCss, minWidth: 170 }}
						>
							<Menu.LinkItem
								css={overlayItemCss}
								render={
									<SiteLink
										href={`/@${orgSlug}/-/files?new=page${parentId ? `&parent=${parentId}` : ''}`}
									/>
								}
							>
								New page
							</Menu.LinkItem>
							<Menu.LinkItem
								css={overlayItemCss}
								render={
									<SiteLink
										href={`/@${orgSlug}/-/files?new=folder${parentId ? `&parent=${parentId}` : ''}`}
									/>
								}
							>
								New directory
							</Menu.LinkItem>
							<Menu.Item css={overlayItemCss} onClick={onUpload}>
								Upload files
							</Menu.Item>
							{canManageStorage && (
								<Menu.Item
									css={overlayItemCss}
									onClick={() => setStorageOpen(true)}
								>
									Storage settings
								</Menu.Item>
							)}
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
			{storageOpen && (
				<Suspense
					fallback={<LoadingIndicator label="Opening storage settings" />}
				>
					<FileStorageSettings
						orgSlug={orgSlug}
						onClose={() => setStorageOpen(false)}
					/>
				</Suspense>
			)}
		</>
	)
}
