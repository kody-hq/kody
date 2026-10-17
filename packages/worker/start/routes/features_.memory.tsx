/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { FeaturePage } from '../pages/features.tsx'
import { MemoryFeature } from '../pages/features/memory.tsx'
export const Route = createFileRoute('/features_/memory')({
	staticData: { shell: { gutters: 'page' }, sessionVerification: 'public' },
	head: staticDocumentHead('featureMemory'),
	component: () => (
		<FeaturePage>
			<MemoryFeature />
		</FeaturePage>
	),
})
