/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { FeaturePage } from '../pages/features.tsx'
import { FilesFeature } from '../pages/features/files.tsx'
export const Route = createFileRoute('/features_/files')({
	staticData: { shell: { gutters: 'page' }, sessionVerification: 'public' },
	head: staticDocumentHead('featureFiles'),
	component: () => (
		<FeaturePage>
			<FilesFeature />
		</FeaturePage>
	),
})
