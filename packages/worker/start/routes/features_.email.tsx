/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { FeaturePage } from '../pages/features.tsx'
import { EmailFeature } from '../pages/features/email.tsx'
export const Route = createFileRoute('/features_/email')({
	staticData: { shell: { gutters: 'page' }, sessionVerification: 'public' },
	head: staticDocumentHead('featureEmail'),
	component: () => (
		<FeaturePage>
			<EmailFeature />
		</FeaturePage>
	),
})
