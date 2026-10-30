import { createFileRoute } from '@tanstack/react-router'
import { profileOgImageHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/profiles_/$username_/og.png')({
	staticData: { documentNavigation: true },
	server: { handlers: { GET: profileOgImageHttp } },
})
