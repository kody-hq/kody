import { acquisitionPageMeta } from './metadata.ts'
import type { AcquisitionPage } from './types.ts'

export const gmail = {
	...acquisitionPageMeta.gmail,
	lead: 'Let your agent handle inbox work with Kody. Prepare replies, turn emails into reports, and save the workflow so you can use it again from any connected agent.',
	flow: [
		'Connect your Google account',
		'Review a saved Gmail workflow',
		'Run it from your agent',
	],
	sections: [
		{
			title: 'Start with the access you actually need',
			paragraphs: [
				'Connect Google to Kody and give your agent access to the email operations your workflow needs.',
				'Reading email, preparing drafts, and sending mail are different actions. Don’t ask for broad mailbox access just because a sample uses it. Follow the Google connection guide for the actual OAuth setup and scopes.',
			],
		},
		{
			title: 'A useful first workflow: prepare replies for review',
			paragraphs: [
				'Ask your agent to collect a small set of messages you choose, prepare suggested replies, and leave them in Drafts. Include the source thread and avoid sending anything as part of the test.',
				'Google doesn’t provide a drafts-only OAuth scope. The compose scope can manage drafts and send mail. To keep the tool limited to drafts, lock both the published package and the integration’s allowed usage. Locking package code alone doesn’t narrow the Google token.',
			],
		},
		{
			title: 'Build a tool that only creates drafts',
			paragraphs: [],
			steps: [
				'Connect Google using the documented setup. Request the narrowest scopes needed for the task.',
				'Create a small package that exposes draft creation, without a send export. Test draft creation on a message you choose.',
				'Lock the published package so an agent can’t silently change the live behavior.',
				'Lock the integration to the approved package. Review the linked guide before relying on this boundary. You’ll need to use the website to unlock it.',
			],
		},
		{
			title: 'When email is only the input',
			paragraphs: [
				'A different package could turn labeled emails into a weekly project report or collect receipts into another service. Decide what data crosses that boundary, where the result goes, and whether a human should approve the output.',
				'Store processing progress with the package so a repeat run can distinguish new messages from ones already handled. Build reply rules, such as quoting the thread, into the package and document its defaults.',
			],
		},
	],
	prompt:
		'Read the Kody Gmail drafts-without-send guide. Help me create a package that prepares drafts for messages I select, with no send operation. Explain the Google scopes, test one draft, then walk me through locking the published package and its integration usage.',
	sources: [
		{
			label: 'Connect Google',
			href: '/docs/google',
		},
		{
			label: 'Google OAuth setup',
			href: '/docs/google-oauth',
		},
		{
			label: 'Gmail drafts without send',
			href: '/docs/locked-gmail-drafts',
		},
		{
			label: 'Google Gmail scopes',
			href: 'https://developers.google.com/workspace/gmail/api/auth/scopes',
		},
	],
	related: ['scheduledWorkflows', 'customTools', 'claudeIntegrations'],
} satisfies AcquisitionPage
