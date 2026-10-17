import { createFileRoute, notFound } from '@tanstack/react-router'

// An unmatched suffix must not inherit a fuzzy admin page's search or loader.
export const Route = createFileRoute('/admin/$')({
	beforeLoad: () => {
		throw notFound({ routeId: '__root__' })
	},
})
