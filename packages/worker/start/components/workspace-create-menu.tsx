/** @jsxImportSource @emotion/react */
import { lazy, Suspense, useState } from 'react'
import { LoadingIndicator } from './loading-indicator.tsx'
const FileStorageSettings = lazy(
	() => import('../pages/file-storage-settings.tsx'),
)
import { Button } from './button.tsx'
import {
	Menu,
	MenuContent,
	MenuItem,
	MenuLinkItem,
	MenuTrigger,
} from './menu.tsx'
import { colors } from '#universal/styles/tokens.ts'
export function WorkspaceCreateMenu({
	orgSlug,
	parentId,
	canCreate,
	onUpload,
	canManageStorage = false,
}: {
	orgSlug: string
	parentId?: string
	canCreate: boolean
	onUpload: () => void
	canManageStorage?: boolean
}) {
	const [storageOpen, setStorageOpen] = useState(false)
	if (!canCreate && !canManageStorage) return null
	return (
		<>
			<Menu>
				<MenuTrigger
					aria-label="Create"
					title="Create"
					render={
						<Button variant="ghost" size="xs" iconOnly css={denseIconCss} />
					}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.3"
						aria-hidden="true"
					>
						<path d="M8 2v12M2 8h12" />
					</svg>
				</MenuTrigger>
				<MenuContent aria-label="Create item">
					{canCreate && (
						<>
							<MenuLinkItem
								href={`/@${orgSlug}/-/files?new=page${parentId ? `&parent=${parentId}` : ''}`}
							>
								New page
							</MenuLinkItem>
							<MenuLinkItem
								href={`/@${orgSlug}/-/files?new=folder${parentId ? `&parent=${parentId}` : ''}`}
							>
								New directory
							</MenuLinkItem>
							<MenuItem onClick={onUpload}>Upload files</MenuItem>
						</>
					)}
					{canManageStorage && (
						<MenuItem onClick={() => setStorageOpen(true)}>
							Storage settings
						</MenuItem>
					)}
				</MenuContent>
			</Menu>
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

// Sits in 28px explorer rows, so touch keeps the same size.
const denseIconCss = {
	color: colors.textMuted,
	'@media (any-pointer: coarse)': { minHeight: 28, minWidth: 28 },
}
