import { createFileRoute } from '@tanstack/react-router'
import { WorkspaceLayout } from '../components/workspace-layout.tsx'

export const Route = createFileRoute('/_app')({
	staticData: { workspaceLayout: 'private' },
	component: WorkspaceLayout,
})
