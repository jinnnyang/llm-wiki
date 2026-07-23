/**
 * Markdown image localizer — Phase 1 (v0.6.6).
 *
 * When a user ingests a `.md` file, this module downloads/copies every
 * `![alt](url "title")` image reference into `wiki/media/<slug>/` and
 * rewrites the body to point at the local copy. See
 * `plans/markdown-image-localizer.md` for the full spec.
 *
 * COMMIT 3a SCOPE: module skeleton — types, extended regex + reference
 * scanner, URL classification with §5's 3-step already-localized check,
 * `resolveLocalRelative` with `isInsideProject` path-traversal defense.
 * COMMIT 3b ADDS: URL cache data layer (`UrlCacheEntry`, `readUrlCache`,
 * `upsertUrlCacheEntry`, `isUrlCacheEntryFresh`, `sha8OfBytes`).
 * The main entry point `localizeMarkdownImages` is intentionally a stub
 * that throws — the download / copyFile / data-URI pipeline (Commit 3c),
 * and decision matrix / VLM (Commit 4) land in later commits.
 */
import { createDirectory, fileExists, readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { isInsideProject } from "@/lib/markdown-image-resolver"
import type { LlmConfig, MultimodalConfig } from "@/stores/wiki-store"
import type { SavedImage } from "@/lib/extract-source-images"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LocalizeOptions {
  projectPath: string
  /** Absolute path of the raw-sources copy (e.g. `<pp>/raw/sources/foo.md`). */
  sourcePath: string
  /** Matches ingest.ts's local var; drives `wiki/media/<slug>/` dir. */
  sourceSummarySlug: string
  /** Markdown body (may include frontmatter). */
  markdown: string
  llmConfig: LlmConfig
  multimodalConfig: MultimodalConfig
  signal?: AbortSignal
  onProgress?: (done: number, total: number, stage: "download" | "caption") => void
  /**
   * Optional override for image dimension probing. Injected primarily
   * for tests — vitest runs under jsdom where `createImageBitmap` is
   * undefined, so unit tests supply a stub. Production callers omit
   * this and get the default `createImageBitmap`-based implementation.
   * Also the seam Phase 2's Rust probe drops in through.
   */
  probeImageDimensions?: (
    mimeType: string,
    bytes: Uint8Array,
  ) => Promise<{ width: number; height: number }>
}

export interface LocalizeResult {
  /**
   * Rewritten md ready to write to `raw/sources/<slug>.md`. Image refs use
   * the `../../wiki/media/<slug>/...` relative form. Frontmatter carries
   * the `image_sources:` mapping.
   */
  rewrittenSourceMarkdown: string
  /**
   * Rewritten md ready to seed `wiki/sources/<slug>.md`. Same body, same
   * frontmatter, but image refs use the `../media/<slug>/...` relative
   * form.
   */
  rewrittenWikiMarkdown: string
  /** Localized image metadata for `injectImagesIntoSourceSummary`. */
  savedImages: SavedImage[]
  stats: {
    // I/O
    downloaded: number
    urlCacheHits: number
    copied: number
    decoded: number
    alreadyLocalized: number
    // VLM
    captioned: number
    captionCacheHits: number
    skippedAuthorAlt: number
    skippedTooSmall: number
    /**
     * Provider can't run VLM (codex-cli); ALL images with empty alt get
     * counted here regardless of size/kind. See §1 Provider capability gate.
     */
    skippedNoVlmProvider: number
    failed: number
  }
}

/**
 * One-of classification of an image `src` URL. See §1 and §5 of the plan.
 *
 * - `remote-http`      — `http://` or `https://`
 * - `data-uri`         — `data:image/...`
 * - `local-relative`   — relative filesystem path, resolves inside project
 * - `already-localized`— matches `wiki/media/<slug>/<name>-<sha8>.<ext>` AND file on disk
 * - `unsupported`      — recognized shape we deliberately don't handle (e.g. `ftp://`)
 * - `failed`           — reference cannot be resolved (missing file, path traversal, malformed)
 */
export type ImageClass =
  | "remote-http"
  | "data-uri"
  | "local-relative"
  | "already-localized"
  | "unsupported"
  | "failed"

// ---------------------------------------------------------------------------
// Regex + scanner (§7)
// ---------------------------------------------------------------------------

/**
 * Extended markdown-image regex. Matches:
 *
 *   ![alt](url)
 *   ![alt](url "title")
 *   ![alt](url 'title')
 *
 * Groups:
 *   1: `![`
 *   2: alt (may be empty, may contain `\]` escaped brackets)
 *   3: `](`
 *   4: url (no whitespace, no `<>`)
 *   5: title delimiter (`"` or `'`) — captured for reference, unused
 *   6: title inner text (whatever the author wrote, incl. escaped delim)
 *   7: `)`
 *
 * Does NOT match `<img>` HTML tags, angle-bracket URLs `![alt](<url>)`,
 * or reference-style images `![alt][id]` — all documented non-goals for
 * Phase 1 (§7).
 */
export const MD_IMAGE_RE_WITH_TITLE =
  /(!\[)((?:\\\]|[^\]])*)(\]\()([^)\s]+)(?:\s+(["'])((?:(?!\5).)*)\5)?(\))/g

/**
 * One image reference found in a markdown body. Offsets are relative
 * to the input string.
 */
export interface ImageRef {
  /** Character offset of the leading `!`. */
  offset: number
  /** Character length of the whole `![...](...)` match. */
  length: number
  /** Alt text, verbatim from source (may contain `\]`). */
  alt: string
  /** URL (no whitespace). */
  url: string
  /**
   * Title inner text, verbatim from source. `undefined` when no title
   * was written; `""` when the author wrote empty quotes.
   */
  title: string | undefined
  /** Title delimiter (`"` or `'`) — undefined when no title. */
  titleDelim: '"' | "'" | undefined
}

/**
 * Scan a markdown body for image references using `MD_IMAGE_RE_WITH_TITLE`.
 * Returns them in source order.
 */
export function findImageReferencesWithTitle(markdown: string): ImageRef[] {
  const refs: ImageRef[] = []
  // Local regex clone — global regexes carry lastIndex state; using
  // `matchAll` on the module-level constant is safe but cloning makes
  // this function reentrant regardless of caller usage.
  const re = new RegExp(MD_IMAGE_RE_WITH_TITLE.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    const [full, , alt, , url, delim, titleInner] = m
    refs.push({
      offset: m.index,
      length: full.length,
      alt,
      url,
      title: titleInner,
      titleDelim: (delim as '"' | "'" | undefined) ?? undefined,
    })
  }
  return refs
}

// ---------------------------------------------------------------------------
// Path helpers (§5, §4)
// ---------------------------------------------------------------------------

/**
 * Regex matching the shape `.../wiki/media/<slug>/<name>-<sha8>.<ext>`
 * anchored at the end of an absolute path. Used by `classifyImageUrl`
 * to detect already-localized references (§5 step 2).
 *
 * `<slug>` and `<name>` allow anything but `/`; `<sha8>` is 8 lowercase
 * hex chars; `<ext>` is any lowercase alphanumeric extension.
 */
export const ALREADY_LOCALIZED_SUFFIX_RE =
  /\/wiki\/media\/[^/]+\/[^/]+-[0-9a-f]{8}\.[a-z0-9]+$/

/**
 * Resolve a relative URL against the raw-sources file's directory,
 * then validate the resulting absolute path stays inside the project
 * root. Path-traversal defense: reuses `isInsideProject`.
 *
 * Returns:
 *   { absPath, insideProject: true }   when resolution succeeds and stays put
 *   { absPath, insideProject: false }  when resolved path escapes the project
 *
 * The absolute path uses forward slashes (`normalizePath` output).
 * Does NOT perform `fileExists` — that's the caller's responsibility.
 */
export function resolveLocalRelative(
  url: string,
  sourceDir: string,
  projectPath: string,
): { absPath: string; insideProject: boolean } {
  const dir = normalizePath(sourceDir).replace(/\/$/, "")
  // Normalize URL: strip any `./` prefix and collapse `\` → `/`.
  const rel = normalizePath(url)

  // Split into segments and resolve `..` / `.` manually. Path.resolve
  // isn't available in the browser bundle, and we want deterministic
  // POSIX-style behavior regardless of host OS.
  const dirSegments = dir.split("/").filter((s) => s.length > 0)
  const relSegments = rel.split("/").filter((s) => s.length > 0)
  const combined: string[] = [...dirSegments]
  for (const seg of relSegments) {
    if (seg === ".") continue
    if (seg === "..") {
      if (combined.length === 0) {
        // Trying to escape the root prefix (e.g. `../` from `/`).
        // isInsideProject will catch this via the reconstructed prefix.
        continue
      }
      combined.pop()
      continue
    }
    combined.push(seg)
  }

  // Preserve leading slash for POSIX absolute paths; preserve
  // `C:` drive letter for Windows absolute paths.
  let absPath: string
  if (dir.startsWith("/")) {
    absPath = "/" + combined.join("/")
  } else if (/^[A-Za-z]:$/.test(dirSegments[0] ?? "")) {
    // `C:` starts a Windows drive; keep it as the first segment.
    absPath = combined.join("/")
  } else {
    absPath = combined.join("/")
  }

  return {
    absPath,
    insideProject: isInsideProject(absPath, projectPath),
  }
}

// ---------------------------------------------------------------------------
// URL cache (§3.2) — data layer only; Commit 3c consumes this
// ---------------------------------------------------------------------------

/**
 * One entry in `.llm-wiki/image-url-cache.json`. Keyed by URL. See §3.2.
 *
 * The `bytesLen` field is recorded for diagnostics/telemetry (activity
 * feed, backup triage) but is not read by the localizer logic itself
 * in Phase 1.
 */
export interface UrlCacheEntry {
  sha256: string
  mimeType: string
  /** 0 when unknown (SVG, decode failed, or probe skipped). */
  width: number
  height: number
  /** Recorded for diagnostics/telemetry; not read by localizer logic in Phase 1. */
  bytesLen: number
  /** ISO 8601 timestamp of the last successful fetch. TTL is measured from here. */
  fetchedAt: string
  /**
   * Project-root-relative path of the FIRST place we wrote this
   * content. Later hits `copyFile` from here instead of re-downloading.
   *
   * Example: "wiki/media/my-notes/logo-abc12345.png".
   */
  canonicalRelPath: string
}

export type UrlCache = Record<string /* url */, UrlCacheEntry>

/** Project-relative path of the on-disk URL cache. */
export const URL_CACHE_REL_PATH = ".llm-wiki/image-url-cache.json"

/**
 * Read the on-disk URL cache. Returns an empty map when the file
 * doesn't exist, is unreadable, or contains malformed JSON. Corrupt
 * cache files log a warning and start fresh — same pattern as
 * `image-caption-pipeline.ts` (see §Risk #5 of the plan).
 */
export async function readUrlCache(projectPath: string): Promise<UrlCache> {
  const cachePath = `${normalizePath(projectPath)}/${URL_CACHE_REL_PATH}`
  if (!(await fileExists(cachePath))) return {}
  try {
    const raw = await readFile(cachePath)
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as UrlCache
    }
  } catch (err) {
    console.warn(
      `[url-cache] corrupt cache at ${cachePath}, starting empty:`,
      err instanceof Error ? err.message : err,
    )
  }
  return {}
}

/**
 * Write the full cache back to disk. Callers should prefer
 * `upsertUrlCacheEntry` — writing a mutated whole map from stale
 * memory drops concurrent updates from other in-flight images
 * (see §3.2 concurrency note). Exposed for tests and one-shot
 * bulk operations only.
 */
async function writeUrlCache(
  projectPath: string,
  cache: UrlCache,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const cachePath = `${pp}/${URL_CACHE_REL_PATH}`
  // `.llm-wiki/` may not exist on a fresh project — createDirectory
  // is idempotent and chains parents.
  await createDirectory(`${pp}/.llm-wiki`)
  await writeFile(cachePath, JSON.stringify(cache, null, 2))
}

/**
 * Per-entry upsert. Re-reads the on-disk cache, sets the one key, and
 * writes the merged result back. This is the pattern used by
 * `image-caption-pipeline.ts` for the same reason: parallel image
 * fetches within a single ingest each finish at different times, and
 * a pipeline-end batch write would drop earlier writes when a later
 * one held a stale in-memory snapshot.
 *
 * The read-modify-write is not atomic — a truly concurrent second
 * writer landing between our read and our write can still lose. That
 * failure mode is documented and accepted in §Risk #5 of the plan
 * (matches the caption cache's behavior).
 */
export async function upsertUrlCacheEntry(
  projectPath: string,
  url: string,
  entry: UrlCacheEntry,
): Promise<void> {
  const current = await readUrlCache(projectPath)
  current[url] = entry
  await writeUrlCache(projectPath, current)
}

/**
 * TTL check. `ttlDays` comes from `multimodalConfig.urlCacheTtlDays`
 * (default 45; see §9). `now` is passed in so tests are deterministic
 * — production callers use `Date.now()`.
 *
 * A malformed / missing `fetchedAt` counts as stale (returns `false`) —
 * safer than a silent "always fresh" pass that would suppress a
 * needed re-fetch. Same story for a fetchedAt in the future (clock
 * skew): we still treat it as fresh, since a false "stale" would
 * force wasted network I/O.
 */
export function isUrlCacheEntryFresh(
  entry: Pick<UrlCacheEntry, "fetchedAt">,
  ttlDays: number,
  now: number,
): boolean {
  const fetched = Date.parse(entry.fetchedAt)
  if (!Number.isFinite(fetched)) return false
  const ageMs = now - fetched
  if (ageMs < 0) return true // future fetchedAt — treat as fresh
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000
  return ageMs <= ttlMs
}

/**
 * Compute an 8-char lowercase hex prefix of SHA-256(bytes). This is
 * the filename disambiguator we append to every localized image
 * (`<name>-<sha8>.<ext>`) and the key we hand to the caption cache.
 *
 * 8 hex chars = 32 bits = collision odds of ~1 in 4B — a design
 * choice: filenames stay human-scannable at the cost of tiny
 * collision risk. Real collisions would surface as one image
 * overwriting another with an unrelated caption; not silent-corruption
 * severity but still worth logging when detected (Commit 3c's dedup
 * path.)
 */
export async function sha8OfBytes(bytes: Uint8Array): Promise<string> {
  // Slice into a fresh ArrayBuffer — TS strict mode treats a bare
  // `Uint8Array` parameter as potentially SharedArrayBuffer-backed,
  // which `crypto.subtle.digest` rejects at the type level. Same
  // workaround as `mineru.ts:bytesToUploadBody`.
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const digest = await crypto.subtle.digest("SHA-256", buf)
  const arr = new Uint8Array(digest).slice(0, 4)
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// ---------------------------------------------------------------------------
// URL classification (§5)
// ---------------------------------------------------------------------------

/**
 * Classify an image `src` URL. See `ImageClass` for the possible
 * outcomes and their semantics.
 *
 * Runs the §5 3-step already-localized check on any local-shape URL
 * (relative or absolute):
 *
 *   1. resolve to absolute path against `sourceDir`
 *   2. regex-match the suffix against `ALREADY_LOCALIZED_SUFFIX_RE`
 *   3. `fileExists(absPath)`
 *
 * All three must pass for `already-localized`; otherwise fall through
 * to `local-relative` (which then requires the file to exist to avoid
 * being marked `failed`).
 *
 * `sourceDir` should be the directory of the raw-sources markdown file
 * (`raw/sources/<slug>.md`'s parent). Callers use `sourcePath` from
 * `LocalizeOptions` — the ingest orchestrator passes an absolute path,
 * and this function computes the directory internally... no, it doesn't:
 * we take `sourceDir` directly so callers can be explicit about which
 * markdown file relative URLs resolve against.
 */
export async function classifyImageUrl(
  url: string,
  sourceDir: string,
  projectPath: string,
): Promise<ImageClass> {
  // 1. Scheme sniff — handled before anything filesystem-y.
  if (url.startsWith("data:")) {
    // Only image/* data URIs are supported; other MIME types are
    // treated as unsupported (Commit 3c's data-URI decoder rejects
    // non-image MIME via its own check).
    if (/^data:image\//i.test(url)) return "data-uri"
    return "unsupported"
  }
  if (/^https?:\/\//i.test(url)) return "remote-http"
  // Any other scheme is deliberately unsupported (ftp, mailto, file, …).
  // Matches the plan's Test 2 expectation for `ftp://x/y` → unsupported.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return "unsupported"

  // 2. Local-shape URL — resolve, validate, then run the 3-step
  //    already-localized check.
  const { absPath, insideProject } = resolveLocalRelative(
    url,
    sourceDir,
    projectPath,
  )
  if (!insideProject) return "failed"

  const exists = await Promise.resolve(fileExists(absPath)).catch(() => false)

  if (ALREADY_LOCALIZED_SUFFIX_RE.test(absPath) && exists) {
    return "already-localized"
  }

  // §5 fall-through: shape matches `wiki/media/<slug>/<name>-<sha8>.<ext>`
  // but file is missing → treat as `local-relative` (and copyFile will
  // fail, at which point the batch marks it `failed`).
  if (exists) return "local-relative"

  return "failed"
}

// ---------------------------------------------------------------------------
// Public entry (STUB — real implementation lands in Commits 3b/3c/4)
// ---------------------------------------------------------------------------

/**
 * Main entry: localize every image reference in `opts.markdown` and
 * return rewritten body + frontmatter + saved-image metadata.
 *
 * STUB (Commit 3a). The classification, caching, download, and VLM
 * layers land in later commits — see the module header for the split.
 */
export async function localizeMarkdownImages(
  _opts: LocalizeOptions,
): Promise<LocalizeResult> {
  throw new Error(
    "localizeMarkdownImages: not implemented yet (Commit 3a scaffold; full pipeline lands in Commits 3b/3c/4)",
  )
}
