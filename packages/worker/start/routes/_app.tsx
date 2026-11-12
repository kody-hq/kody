import { createFileRoute } from '@tanstack/react-router'
import { WorkspaceLayout } from '../components/workspace-layout.tsx'
import { SidebarPreferencesProvider } from '../components/sidebar-preferences.tsx'
import { readSidebarPreferences } from '../server/sidebar-preferences.ts'

export const Route = createFileRoute('/_app')({
	staticData: { workspaceLayout: 'private' },
	beforeLoad: () => ({ sidebarPreferences: readSidebarPreferences() }),
	component: AppWorkspace,
})

function AppWorkspace() {
	const { sidebarPreferences } = Route.useRouteContext()
	return (
		<SidebarPreferencesProvider value={sidebarPreferences}>
			<WorkspaceLayout />
		</SidebarPreferencesProvider>
	)
}
