# YouTube watch overlay

Site-wide `/?youtubeId=<id>` player for allowlisted YouTube videos.

## Surfaces

- **Watch URL**: `/?youtubeId=<11-character-id>` on any app path
  (`/blog?youtubeId=` also works). Unknown or disallowed ids do not open the
  player.
- **Homepage hero**: `/` two-column player + video chooser
  (`landing-hero-video.tsx`). The chooser list and order come from the unlisted
  playlist `landingHeroSourcePlaylistId` (`PLBPBUA8boGLA`), loaded at request
  time and KV-cached with SWR. The homepage lite player embeds the selected
  chooser video only, without a playlist id, so YouTube player chrome uses that
  video's title. Chooser ids are allowlisted when thumbs or `?youtubeId=` load
  playlists, so `/youtube-thumb/:id` works for those videos.
- **Thumbnail proxy**: `GET /youtube-thumb/:videoId` (404 unless allowlisted).
  Fetches `maxresdefault.jpg` first (1280×720), then `sddefault.jpg`, then
  `hqdefault.jpg` when a higher quality is missing.

The overlay player is a first-party `<dialog>` with a poster + play control.
Play swaps in `https://www.youtube-nocookie.com/embed/<id>?autoplay=1`. Closing
strips the `youtubeId` query param. CSP allows that embed host in `frame-src`
only; `img-src` stays first-party. The homepage hero uses the same lite player
outside the overlay.

## Allowlist

A video id is allowed when it appears in any of:

1. The latest items from `YOUTUBE_ALLOWED_PLAYLIST_IDS` (YouTube playlist Atom
   feed, typically ~15 items per playlist, cached about an hour)
2. `YOUTUBE_ALLOWED_VIDEO_IDS` (comma-separated extra ids)
3. The sample id (`youtubeWatchSampleVideoId`) used by tests and fixtures
4. Homepage hero chooser ids from `landingHeroSourcePlaylistId` so `/` posters
   and `/youtube-thumb/:id` thumbs work without `?youtubeId=`. That fetch shares
   the home loader's KV SWR cache.
5. Video ids authored in first-party docs `> [!WATCH]` blocks. Those posters
   stay allowed when the film is unlisted and absent from the public Atom feed.

The overlay follows the live `youtubeId` search param only. Closing strips that
param; it does not fall back to SSR loader data, so the dialog stays closed
across client navigations.

Unset playlist env means no overlay playlist fetch (tests stay offline). `none`
disables overlay playlists explicitly. Production and preview set Kent's public
overlay playlist id in `packages/worker/wrangler.jsonc` so shared `/?youtubeId=`
links work. The Atom feed is not the full catalog and is not the homepage
chooser source.

Failed playlist fetches fail open: env extra ids stay in the allowlist. A failed
homepage playlist fetch fails open to an empty chooser.

SSR documents other than `/` without `?youtubeId=` skip both the overlay Atom
fetch and the homepage hero playlist fetch. They merge env extras and the sample
id. `?youtubeId=` HTML and `/youtube-thumb/:videoId` load playlists (including
hero chooser ids). Shared watch links are full document loads, so they resolve
playlist ids.

Homepage `/` always loads the chooser playlist for SSR (and
`GET /landing-hero-videos.json` for client navigations), even when the request
has no `youtubeId`. That path prefers an optional origin-only
`YOUTUBE_DATA_API_KEY` (`playlistItems`, playlist order) and falls back to
YouTube's public Innertube browse endpoint so local and preview work without a
key.

## Code

- Parse / thumb rewrite: `packages/worker/universal/youtube-watch.ts`
- Playlist order (Data API + Innertube):
  `packages/worker/universal/youtube-playlist.ts`
- Homepage hero load + KV SWR: `packages/worker/src/app/landing-hero-videos.ts`
- Allowlist: `packages/worker/src/app/youtube-watch-allowlist.ts`
- SSR snapshot: `packages/worker/src/app/youtube-watch-ssr.ts`
- Thumb proxy: `packages/worker/src/app/handlers/youtube-thumb.ts`
- Overlay: `packages/worker/start/components/youtube-watch-overlay.tsx`
- Homepage hero player:
  `packages/worker/start/components/landing-hero-video.tsx` and
  `packages/worker/universal/landing-hero-copy.ts`
