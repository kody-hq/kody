export const triggerExamples = {
	purchase: {
		when: 'A purchase completes',
		package: 'Purchase thanks',
		result: 'Thank-you draft ready',
		detail: 'Verified payment. Draft saved for review.',
	},
	issue: {
		when: 'An issue opens',
		package: 'Sentry triage',
		result: 'Issue ready for investigation',
		detail: 'Verified delivery. Follow-up work queued.',
	},
	email: {
		when: 'An email arrives',
		package: 'Inbox router',
		result: 'Matching mail routed',
		detail: 'Plus-tag matched. Handler started.',
	},
	schedule: {
		when: 'The daily check is due',
		package: 'Flake Hunter',
		result: 'No flakes found',
		detail: 'Scan complete. No notification.',
	},
}
export const signals = {
	webhook: {
		name: 'Purchase thanks',
		detail:
			'A verified purchase starts the package. It saves a thank-you draft for review.',
		href: '/docs/purchase-thanks',
	},
	inbox: {
		name: 'Inbox router',
		detail:
			'A matching plus-tag starts the handler. The package decides what to do with that mail.',
		href: '/docs/agent-inbox',
	},
	package: {
		name: 'A package event',
		detail:
			'One package emits an event. Other saved packages in the same account can react.',
		href: '/docs/package-subscriptions',
	},
	clock: {
		name: 'Flake Hunter',
		detail:
			'A daily job scans CI results. The package decides whether the result needs attention.',
		href: '/docs/flake-hunter',
	},
}
