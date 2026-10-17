export const businessExamples = {
	invoices: {
		title: 'Monthly invoicing',
		request:
			'“Turn our completed jobs into invoice drafts. Flag anything that doesn’t add up.”',
		steps: [
			'Read completed jobs',
			'Match rates and purchase orders',
			'Prepare drafts for review',
		],
		trigger: 'Runs on the 1st of each month · Accounting connection',
		heading: 'October invoice review',
		sub: 'Acme Construction · Drafts ready for review',
		rows: [
			['Riverside renovation', '$4,800'],
			['Oak Street fit-out', '$7,250'],
			['Depot maintenance', 'Missing PO'],
		],
		foot: '2 drafts prepared · 1 item needs your review',
		prompt: 'What needs my attention before we invoice?',
		tool: 'invoice_reconciliation.review()',
		answer:
			'Two jobs have invoice drafts ready. Depot maintenance is missing a purchase order. Add the PO before creating its draft.',
	},
	audit: {
		title: 'Nightly audits',
		request:
			'“Check every open project for missing paperwork and give our team a list each morning.”',
		steps: [
			'Read open projects',
			'Check required documents',
			'Save the exceptions report',
		],
		trigger: 'Runs nightly at 02:00 · Project records connection',
		heading: 'Morning exceptions',
		sub: 'Acme Construction · Latest nightly audit',
		rows: [
			['Riverside renovation', 'Insurance expired'],
			['Oak Street fit-out', 'All checks passed'],
			['Depot maintenance', 'Permit missing'],
		],
		foot: '2 exceptions ready for the operations team',
		prompt: 'Which projects need attention this morning?',
		tool: 'project_audit.latest_exceptions()',
		answer:
			'Riverside has an expired insurance certificate. Depot is missing a permit. Oak Street passed all document checks.',
	},
	onboarding: {
		title: 'Client onboarding',
		request:
			'“When a deal closes, set up the project and tell us what we still need from the client.”',
		steps: [
			'Read the closed deal',
			'Create the project checklist',
			'Request the missing details',
		],
		trigger: 'Triggered by a closed deal · CRM connection',
		heading: 'Riverside project setup',
		sub: 'Acme Construction · New project checklist',
		rows: [
			['Project workspace', 'Created'],
			['Primary contact', 'Added'],
			['Site access details', 'Requested'],
		],
		foot: 'Project ready · Waiting for site access details',
		prompt: 'Is the Riverside project ready to start?',
		tool: 'project_onboarding.get_status()',
		answer:
			'The project workspace and primary contact are set up. Site access details have been requested and are still outstanding.',
	},
} as const
export type BusinessExample = keyof typeof businessExamples
