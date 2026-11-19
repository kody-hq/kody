/**
 * First-party blog image paths: origin-relative `/images/...` paths, either
 * static files under `packages/worker/public/images/` or, for
 * `/images/blog/...`, R2 objects served by the worker
 * (`#worker/blog/blog-image-store.ts`). Shared by frontmatter `image` fields and
 * inline post-body screenshots so both follow one rule.
 */
export const BLOG_IMAGE_PATTERN =
	/^\/images\/[a-z0-9][a-z0-9/-]*\.(?:avif|jpe?g|png|webp)$/

export function isBlogImagePath(src: string): boolean {
	return BLOG_IMAGE_PATTERN.test(src)
}
