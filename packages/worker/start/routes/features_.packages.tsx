/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { FeaturePage } from '../pages/features.tsx'
import { PackagesFeature } from '../pages/features/packages.tsx'
export const Route = createFileRoute('/features_/packages')({
	staticData: { shell: { gutters: 'page' }, sessionVerification: 'public' },
	head: staticDocumentHead('featurePackages'),
	component: () => (
		<FeaturePage>
			<PackagesFeature />
		</FeaturePage>
	),
})
