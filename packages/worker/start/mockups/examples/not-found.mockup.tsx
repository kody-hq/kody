/** @jsxImportSource @emotion/react */
import { NotFoundPage } from '../../components/not-found-page.tsx'
import type { Mockup } from '../mockup.ts'

/** Example: an existing page in the marketing shell. Compare with any 404 on kody.codes. */
export default {
	title: 'Not found page (example)',
	description: 'The real 404 page inside the real header and footer',
	shell: 'marketing',
	states: {
		default: () => <NotFoundPage />,
	},
} satisfies Mockup
