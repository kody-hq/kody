/** @jsxImportSource @emotion/react */
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { type AdminInsightsLoaderData } from '#universal/loader-data.ts'
import {
	AccountManagementShell,
	AdminPageHeader,
} from './account-management-components.tsx'
import { renderDashboard } from './admin-insights-dashboard.tsx'
export function AdminInsightsRoute({
	data,
}: {
	data: AdminInsightsLoaderData
}) {
	const currentHref = useMatchedPageScope().pageLocation.href
	return (
		<AccountManagementShell
			currentHref={currentHref}
			maxWidth="min(100%, 92rem)"
		>
			<AdminPageHeader
				title="Admin insights"
				description="Launch signals, paid mix, cost vs pay, and platform activity. Aggregated account metadata only, user content is never shown."
				currentHref={currentHref}
			/>
			{renderDashboard(data)}
		</AccountManagementShell>
	)
}
