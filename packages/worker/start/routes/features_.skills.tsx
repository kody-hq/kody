/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { FeaturePage } from '../pages/features.tsx'
import { SkillsFeature } from '../pages/features/skills.tsx'
export const Route = createFileRoute('/features_/skills')({
	staticData: { shell: { gutters: 'page' }, sessionVerification: 'public' },
	head: staticDocumentHead('featureSkills'),
	component: () => (
		<FeaturePage>
			<SkillsFeature />
		</FeaturePage>
	),
})
