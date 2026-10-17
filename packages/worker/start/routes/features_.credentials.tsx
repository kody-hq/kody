/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { staticDocumentHead } from '../components/document-head.ts'
import { FeaturePage } from '../pages/features.tsx'
import { CredentialsFeature } from '../pages/features/credentials.tsx'
export const Route = createFileRoute('/features_/credentials')({
	staticData: { shell: { gutters: 'page' }, sessionVerification: 'public' },
	head: staticDocumentHead('featureCredentials'),
	component: () => (
		<FeaturePage>
			<CredentialsFeature />
		</FeaturePage>
	),
})
