/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadDevicePage } from '#start/server/device'
import {
	handleDevicePost,
	rejectDeviceMethod,
} from '#start/server/device-protocol'
import { DeviceRoute } from '../pages/device.tsx'

export const Route = createFileRoute('/device')({
	server: {
		handlers: {
			POST: handleDevicePost,
			PUT: rejectDeviceMethod,
			PATCH: rejectDeviceMethod,
			DELETE: rejectDeviceMethod,
			OPTIONS: rejectDeviceMethod,
		},
	},
	staticData: {
		documentNavigation: true,
		shell: { preserveLoginReturn: true },
	},
	head: staticDocumentHead('device'),
	preload: false,
	loaderDeps: ({ search }) => search,
	loader: ({ location }) => loadDevicePage({ data: location.searchStr }),
	component: Page,
})

function Page() {
	const { pageLocation: location } = Route.useRouteContext()
	return <DeviceRoute key={location.searchStr} data={Route.useLoaderData()} />
}
