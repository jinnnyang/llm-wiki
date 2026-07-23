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
 * COMMIT 3c ADDS: HTTP fetch with SSRF / Content-Length / streaming size /
 * Content-Type / timeout defenses, data-URI decoder with truncation and
 * MIME/size guards, and the main `localizeMarkdownImages` entry point
 * (no VLM yet — that's Commit 4). Body rewriting via `rewriteBySlot`
 * and frontmatter `image_sources:` merging via
 * `mergeImageSourcesFrontmatter` are also Commit 4 territory, so the
 * `rewrittenSourceMarkdown` / `rewrittenWikiMarkdown` fields of the
 * result are populated with an empty string in this commit — the
 * `savedImages` and `stats` outputs, plus every I/O side effect, are
 * fully functional.
 */
import {
  copyFile,
  createDirectory,
  fileExists,
  readFile,
  writeFile,
  writeFileBase64,
} from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { isInsideProject } from "@/lib/markdown-image-resolver"
import {
  fetchImportUrl,
  isPrivateNetworkHost,
  validateHttpUrl,
} from "@/lib/url-source-import"
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
// Network / data-URI defenses (§10, Commit 3c)
// ---------------------------------------------------------------------------

/**
 * Hard cap on any image byte payload we accept — remote body, data URI
 * decoded size, or copied local file. 20 MB is the same limit as
 * `mineru.ts`'s upload guard. Prevents a 4K video linked as an
 * "image" from filling the media dir.
 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Default HTTP fetch timeout (matches §10 rule 6). */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000

/** Content-Type prefix every remote image response must carry. */
const IMAGE_MIME_PREFIX = "image/"

/** Data URI truncation cap for frontmatter (§11 table). */
const DATA_URI_FRONTMATTER_CAP = 64

/**
 * Minimal MIME → extension map. Only the shapes we actually emit into
 * `wiki/media/<slug>/<name>-<sha8>.<ext>`. Unknown MIME → `bin`; the
 * caller can log a warning and count the image as `failed` upstream
 * if `bin` isn't acceptable.
 */
function extFromMime(mime: string): string {
  const norm = mime.toLowerCase().split(";")[0].trim()
  switch (norm) {
    case "image/png":
      return "png"
    case "image/jpeg":
    case "image/jpg":
      return "jpg"
    case "image/webp":
      return "webp"
    case "image/gif":
      return "gif"
    case "image/svg+xml":
      return "svg"
    case "image/bmp":
      return "bmp"
    case "image/avif":
      return "avif"
    case "image/heic":
    case "image/heif":
      return "heic"
    case "image/tiff":
      return "tiff"
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return "ico"
    default:
      return "bin"
  }
}

/**
 * Convert `Uint8Array` to base64 in fixed-size chunks. Same shape as
 * the private helper in `mineru.ts` — inlined here to keep the two
 * modules from sharing an ad-hoc utility.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

/**
 * Read a `Response.body` stream, refusing to buffer more than `cap`
 * bytes. Aborts the stream and throws when the cap is exceeded. Used
 * for the streaming-size defense in §10 rule 5 — catches missing or
 * lying `Content-Length`.
 */
async function readBodyWithLimit(
  response: Response,
  cap: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) {
    // No stream — fall back to arrayBuffer(), but still enforce cap
    // after the fact.
    const buf = new Uint8Array(await response.arrayBuffer())
    if (buf.byteLength > cap) {
      throw new Error(
        `Image body exceeds ${cap} bytes (received ${buf.byteLength})`,
      )
    }
    return buf
  }
  const chunks: Uint8Array[] = []
  let total = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > cap) {
      // Cancel the underlying stream so the socket closes.
      await reader.cancel().catch(() => {})
      throw new Error(
        `Image body exceeds ${cap} bytes during streaming read`,
      )
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Fetch a remote image URL with the full §10 defense stack:
 *
 *   1. `validateHttpUrl` — scheme + no embedded credentials
 *   2. `isPrivateNetworkHost` on the initial host
 *   3. `fetchImportUrl` — MAX_REDIRECTS loop + public→private block
 *   4. `AbortSignal.timeout(timeoutMs)` (composed with an optional
 *      caller signal)
 *   5. `Content-Type` prefix check → must start with `image/`
 *   6. `Content-Length` preflight → reject > 20 MB
 *   7. Streaming size cap during body read
 *
 * Returns the raw bytes and the response's declared MIME type.
 * `fetchImpl` is injected for tests; production callers omit it and
 * get `globalThis.fetch`.
 */
export async function fetchRemoteImage(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  callerSignal?: AbortSignal,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  // 1 + 2: scheme + initial host guard. `fetchImportUrl` re-validates
  // on every redirect hop, but the initial check here gives a clean
  // error path before we open any socket.
  const initial = validateHttpUrl(url)
  if (isPrivateNetworkHost(initial.hostname)) {
    throw new Error(
      `Refusing to fetch image from private/local host: ${initial.hostname}`,
    )
  }

  // Compose timeout with caller's abort. `AbortSignal.any` is standard
  // as of 2024 but not universally available; fall back to a manual
  // combiner if needed.
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal: AbortSignal = callerSignal
    ? (typeof (AbortSignal as unknown as { any?: unknown }).any === "function"
        ? (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([
            timeoutSignal,
            callerSignal,
          ])
        : timeoutSignal)
    : timeoutSignal

  // 3: redirect-safe fetch.
  const response = await fetchImportUrl(fetchImpl, url, signal)

  if (!response.ok) {
    throw new Error(
      `Image fetch failed: ${response.status} ${response.statusText || ""}`.trim(),
    )
  }

  // 5: Content-Type gate.
  const rawType = response.headers.get("content-type") ?? ""
  const mimeType = rawType.split(";")[0].trim().toLowerCase()
  if (!mimeType.startsWith(IMAGE_MIME_PREFIX)) {
    throw new Error(
      `Refusing non-image response: Content-Type=${rawType || "(missing)"}`,
    )
  }

  // 6: Content-Length preflight.
  const declaredLen = response.headers.get("content-length")
  if (declaredLen) {
    const n = Number.parseInt(declaredLen, 10)
    if (Number.isFinite(n) && n > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image body exceeds ${MAX_IMAGE_BYTES} bytes (Content-Length=${n})`,
      )
    }
  }

  // 7: streaming read with hard cap.
  const bytes = await readBodyWithLimit(response, MAX_IMAGE_BYTES)
  return { bytes, mimeType }
}

/**
 * Decode a `data:image/...;base64,...` URI. Enforces:
 *
 *   - MIME must start with `image/`
 *   - encoding must be base64 (charset= is tolerated but ignored)
 *   - decoded size must be ≤ 20 MB
 *   - malformed base64 rejected
 *
 * Non-base64 data URIs (e.g. `data:image/svg+xml,<svg...`) are
 * currently rejected — Phase 1 non-goal. Not a security concern
 * (they can be added later) — just a scope choice.
 */
export function resolveDataUri(
  dataUri: string,
): { bytes: Uint8Array; mimeType: string } {
  // Shape: data:<mediatype>[;<param>]*[;base64],<data>
  const match = /^data:([^,;]+)((?:;[^,]+)*),(.*)$/i.exec(dataUri)
  if (!match) throw new Error("Malformed data URI")
  const mimeType = match[1].toLowerCase().trim()
  const params = match[2].toLowerCase()
  const payload = match[3]
  if (!mimeType.startsWith(IMAGE_MIME_PREFIX)) {
    throw new Error(`Non-image data URI: ${mimeType}`)
  }
  if (!/;base64\b/.test(params)) {
    throw new Error("Data URI is not base64-encoded (Phase 1 non-goal)")
  }
  let bytes: Uint8Array
  try {
    // atob returns latin-1 chars — each maps to one output byte.
    const binary = atob(payload)
    bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  } catch {
    throw new Error("Malformed base64 in data URI")
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Data URI decoded size exceeds ${MAX_IMAGE_BYTES} bytes`,
    )
  }
  return { bytes, mimeType }
}

/**
 * Truncate a data URI for frontmatter storage per §11 table.
 * Full base64 in YAML bloats the file; a short marker preserves the
 * "this was inline base64" signal without the size penalty.
 */
export function truncateDataUriForFrontmatter(dataUri: string): string {
  if (dataUri.length <= DATA_URI_FRONTMATTER_CAP) return dataUri
  return dataUri.slice(0, DATA_URI_FRONTMATTER_CAP) + "…"
}

// ---------------------------------------------------------------------------
// Public entry — main pipeline (Commit 3c; no VLM, no body rewrite)
// ---------------------------------------------------------------------------

/**
 * One localized image on the way into `SavedImage[]`. Internal shape;
 * `localizeMarkdownImages` converts these into the public `SavedImage`.
 */
interface LocalizedImage {
  ref: ImageRef
  sha8: string
  mimeType: string
  width: number
  height: number
  /** Absolute filesystem path where the bytes were written. */
  absPath: string
  /** Project-root-relative path (e.g. `wiki/media/slug/foo-abc12345.png`). */
  relPath: string
  /** For remote-http and data-uri: original URL for frontmatter mapping. */
  originalUrl: string | undefined
  /** Byte length — recorded for stats/telemetry. */
  bytesLen: number
  /** Which classification path produced this image. */
  origin: "remote-http" | "data-uri" | "local-relative" | "already-localized"
}

/**
 * Main entry: for every `![alt](url ...)` reference in `opts.markdown`,
 * resolve/download/copy the bytes into `wiki/media/<slug>/`, dedup
 * by content SHA, update the URL cache, and produce `SavedImage[]`
 * plus a `stats` summary.
 *
 * COMMIT 3c LIMITATION: VLM captioning is not wired in (Commit 4).
 * Body rewriting via `rewriteBySlot` and frontmatter merge via
 * `mergeImageSourcesFrontmatter` are also Commit 4 territory, so the
 * `rewrittenSourceMarkdown` and `rewrittenWikiMarkdown` fields come
 * back as empty strings. Everything else — I/O, caching, stats,
 * `savedImages` — is production-quality.
 */
export async function localizeMarkdownImages(
  opts: LocalizeOptions,
): Promise<LocalizeResult> {
  const {
    projectPath,
    sourcePath,
    sourceSummarySlug,
    markdown,
    multimodalConfig,
    signal,
  } = opts

  const pp = normalizePath(projectPath)
  const sourceDir = normalizePath(sourcePath).replace(/\/[^/]+$/, "")
  const mediaDir = `${pp}/wiki/media/${sourceSummarySlug}`
  const now = Date.now()
  const timeoutMs =
    multimodalConfig.imageFetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const ttlDays = multimodalConfig.urlCacheTtlDays ?? 45

  const refs = findImageReferencesWithTitle(markdown)
  const localized: LocalizedImage[] = []
  const stats: LocalizeResult["stats"] = {
    downloaded: 0,
    urlCacheHits: 0,
    copied: 0,
    decoded: 0,
    alreadyLocalized: 0,
    captioned: 0,
    captionCacheHits: 0,
    skippedAuthorAlt: 0,
    skippedTooSmall: 0,
    skippedNoVlmProvider: 0,
    failed: 0,
  }

  if (refs.length === 0) {
    return {
      rewrittenSourceMarkdown: "",
      rewrittenWikiMarkdown: "",
      savedImages: [],
      stats,
    }
  }

  await createDirectory(mediaDir)

  // In-run URL cache snapshot to avoid re-reading disk between refs;
  // updates are still persisted per-image via `upsertUrlCacheEntry` to
  // survive interleaved runs (§3.2 concurrency note).
  const urlCache = await readUrlCache(projectPath)

  for (const ref of refs) {
    if (signal?.aborted) break
    try {
      const cls = await classifyImageUrl(ref.url, sourceDir, projectPath)
      switch (cls) {
        case "already-localized": {
          stats.alreadyLocalized += 1
          const { absPath } = resolveLocalRelative(
            ref.url,
            sourceDir,
            projectPath,
          )
          const relPath = absPath.startsWith(pp + "/")
            ? absPath.slice(pp.length + 1)
            : absPath
          // Preserve the reference by recording it in `savedImages`
          // with `sha256`/`sha8` unknown — the file is already on disk
          // and we don't re-read it. Commit 4's rewriter can decide
          // whether to leave the ref untouched or re-emit.
          localized.push({
            ref,
            sha8: "",
            mimeType: "",
            width: 0,
            height: 0,
            absPath,
            relPath,
            originalUrl: undefined,
            bytesLen: 0,
            origin: "already-localized",
          })
          break
        }
        case "remote-http": {
          const result = await handleRemoteHttp(ref.url, {
            projectPath,
            pp,
            mediaDir,
            sourceSummarySlug,
            urlCache,
            ttlDays,
            timeoutMs,
            now,
            signal,
          })
          if (result.cacheHit) stats.urlCacheHits += 1
          else stats.downloaded += 1
          localized.push({
            ref,
            sha8: result.sha8,
            mimeType: result.mimeType,
            width: result.width,
            height: result.height,
            absPath: result.absPath,
            relPath: result.relPath,
            originalUrl: ref.url,
            bytesLen: result.bytesLen,
            origin: "remote-http",
          })
          break
        }
        case "data-uri": {
          const result = await handleDataUri(ref.url, {
            mediaDir,
            pp,
          })
          stats.decoded += 1
          localized.push({
            ref,
            sha8: result.sha8,
            mimeType: result.mimeType,
            width: 0,
            height: 0,
            absPath: result.absPath,
            relPath: result.relPath,
            originalUrl: ref.url,
            bytesLen: result.bytesLen,
            origin: "data-uri",
          })
          break
        }
        case "local-relative": {
          const result = await handleLocalRelative(ref.url, {
            sourceDir,
            projectPath,
            mediaDir,
            pp,
          })
          stats.copied += 1
          localized.push({
            ref,
            sha8: result.sha8,
            mimeType: result.mimeType,
            width: 0,
            height: 0,
            absPath: result.absPath,
            relPath: result.relPath,
            originalUrl: undefined,
            bytesLen: result.bytesLen,
            origin: "local-relative",
          })
          break
        }
        case "unsupported":
        case "failed":
        default: {
          stats.failed += 1
          console.warn(
            `[localizer] Skipping image (${cls}): ${ref.url.slice(0, 120)}`,
          )
          break
        }
      }
    } catch (err) {
      stats.failed += 1
      console.warn(
        `[localizer] Failed to localize ${ref.url.slice(0, 120)}: `,
        err instanceof Error ? err.message : err,
      )
    }
  }

  const savedImages: SavedImage[] = localized
    .filter((li) => li.origin !== "already-localized")
    .map((li, index) => ({
      index,
      mimeType: li.mimeType,
      page: null,
      width: li.width,
      height: li.height,
      relPath: li.relPath.startsWith("wiki/")
        ? li.relPath.slice("wiki/".length)
        : li.relPath,
      absPath: li.absPath,
      sha256: li.sha8, // sha8 stored here — Commit 4 upgrades to full SHA-256
    }))

  return {
    // Body rewriting lands in Commit 4 — see module header.
    rewrittenSourceMarkdown: "",
    rewrittenWikiMarkdown: "",
    savedImages,
    stats,
  }
}

// ---------------------------------------------------------------------------
// Per-branch handlers (private)
// ---------------------------------------------------------------------------

interface RemoteContext {
  projectPath: string
  pp: string
  mediaDir: string
  sourceSummarySlug: string
  urlCache: UrlCache
  ttlDays: number
  timeoutMs: number
  now: number
  signal: AbortSignal | undefined
}

async function handleRemoteHttp(
  url: string,
  ctx: RemoteContext,
): Promise<{
  sha8: string
  mimeType: string
  width: number
  height: number
  absPath: string
  relPath: string
  bytesLen: number
  cacheHit: boolean
}> {
  const cached = ctx.urlCache[url]
  if (cached && isUrlCacheEntryFresh(cached, ctx.ttlDays, ctx.now)) {
    // URL cache hit within TTL — canonical file must be readable for
    // the hit to count. If the canonical file was deleted since,
    // fall through to a fresh fetch.
    const canonicalAbs = `${ctx.pp}/${cached.canonicalRelPath}`
    if (await fileExists(canonicalAbs)) {
      return {
        sha8: cached.sha256.slice(0, 8),
        mimeType: cached.mimeType,
        width: cached.width,
        height: cached.height,
        absPath: canonicalAbs,
        relPath: cached.canonicalRelPath,
        bytesLen: cached.bytesLen,
        cacheHit: true,
      }
    }
  }

  // Cache miss OR expired OR canonical file missing → fetch.
  const { bytes, mimeType } = await fetchRemoteImage(
    url,
    ctx.timeoutMs,
    globalThis.fetch,
    ctx.signal,
  )
  const sha8 = await sha8OfBytes(bytes)
  const ext = extFromMime(mimeType)
  const baseName = deriveNameFromUrl(url)
  const fileName = `${baseName}-${sha8}.${ext}`
  const absPath = `${ctx.mediaDir}/${fileName}`
  const relPath = `wiki/media/${ctx.sourceSummarySlug}/${fileName}`

  // If the canonical file already exists (same bytes → same sha8 → same
  // filename), skip the write — copyFile is idempotent but writeFileBase64
  // isn't guaranteed to be atomic on all backends.
  if (!(await fileExists(absPath))) {
    await writeFileBase64(absPath, bytesToBase64(bytes))
  }

  // Compute full SHA-256 for the URL cache entry. sha8 is enough for the
  // filename disambiguator, but the cache carries the full digest so
  // future consumers (dedup verification, caption cache alignment) can
  // key on it.
  const fullSha256 = await sha256OfBytesFull(bytes)

  await upsertUrlCacheEntry(ctx.projectPath, url, {
    sha256: fullSha256,
    mimeType,
    width: 0,
    height: 0,
    bytesLen: bytes.byteLength,
    fetchedAt: new Date(ctx.now).toISOString(),
    canonicalRelPath: relPath,
  })

  return {
    sha8,
    mimeType,
    width: 0,
    height: 0,
    absPath,
    relPath,
    bytesLen: bytes.byteLength,
    cacheHit: false,
  }
}

interface DataUriContext {
  mediaDir: string
  pp: string
}

async function handleDataUri(
  dataUri: string,
  ctx: DataUriContext,
): Promise<{
  sha8: string
  mimeType: string
  absPath: string
  relPath: string
  bytesLen: number
}> {
  const { bytes, mimeType } = resolveDataUri(dataUri)
  const sha8 = await sha8OfBytes(bytes)
  const ext = extFromMime(mimeType)
  const fileName = `inline-${sha8}.${ext}`
  const absPath = `${ctx.mediaDir}/${fileName}`
  const relPath = absPath.startsWith(ctx.pp + "/")
    ? absPath.slice(ctx.pp.length + 1)
    : absPath
  if (!(await fileExists(absPath))) {
    await writeFileBase64(absPath, bytesToBase64(bytes))
  }
  return { sha8, mimeType, absPath, relPath, bytesLen: bytes.byteLength }
}

interface LocalRelativeContext {
  sourceDir: string
  projectPath: string
  mediaDir: string
  pp: string
}

async function handleLocalRelative(
  url: string,
  ctx: LocalRelativeContext,
): Promise<{
  sha8: string
  mimeType: string
  absPath: string
  relPath: string
  bytesLen: number
}> {
  const { absPath: srcAbs } = resolveLocalRelative(
    url,
    ctx.sourceDir,
    ctx.projectPath,
  )
  // Reading via readFile (utf8) would corrupt binary bytes; use the
  // base64 command so we get raw bytes back through a text-safe channel.
  // The command also returns the Rust-side MIME guess, which is more
  // accurate than sniffing the extension.
  const { readFileAsBase64 } = await import("@/commands/fs")
  const { base64: b64, mimeType: probedMime } = await readFileAsBase64(srcAbs)
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Local image exceeds ${MAX_IMAGE_BYTES} bytes: ${srcAbs}`,
    )
  }
  const sha8 = await sha8OfBytes(bytes)
  const mimeType = probedMime && probedMime.startsWith(IMAGE_MIME_PREFIX)
    ? probedMime
    : extToMime(
        (url.match(/\.([a-z0-9]+)(?:[?#].*)?$/i)?.[1] ?? "bin").toLowerCase(),
      )
  const ext = extFromMime(mimeType)
  const baseName = deriveNameFromUrl(url)
  const fileName = `${baseName}-${sha8}.${ext}`
  const absPath = `${ctx.mediaDir}/${fileName}`
  const relPath = absPath.startsWith(ctx.pp + "/")
    ? absPath.slice(ctx.pp.length + 1)
    : absPath
  if (!(await fileExists(absPath))) {
    await copyFile(srcAbs, absPath)
  }
  return {
    sha8,
    mimeType,
    absPath,
    relPath,
    bytesLen: bytes.byteLength,
  }
}

/**
 * Extract a filename stem from the URL path, sanitized for filesystem
 * use. Falls back to `"image"` when the URL has no useful basename.
 */
function deriveNameFromUrl(url: string): string {
  try {
    // Try URL parsing first — handles query strings and hashes cleanly.
    const parsed = new URL(
      url,
      // A bogus base is enough to parse relative URLs; we only use
      // `.pathname`.
      "https://placeholder.invalid/",
    )
    const leaf = parsed.pathname.split("/").filter(Boolean).pop() ?? ""
    const stem = leaf.replace(/\.[a-z0-9]+$/i, "")
    const cleaned = stem
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
    return cleaned || "image"
  } catch {
    return "image"
  }
}

/** Inverse of `extFromMime` for a few common extensions. */
function extToMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case "png":
      return "image/png"
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "webp":
      return "image/webp"
    case "gif":
      return "image/gif"
    case "svg":
      return "image/svg+xml"
    case "bmp":
      return "image/bmp"
    case "avif":
      return "image/avif"
    case "heic":
    case "heif":
      return "image/heic"
    case "tiff":
    case "tif":
      return "image/tiff"
    case "ico":
      return "image/x-icon"
    default:
      return "application/octet-stream"
  }
}

/**
 * Full SHA-256 (not the 8-char prefix). Used by the URL cache to key
 * against the caption cache. Same TS-strict-mode ArrayBuffer dance as
 * `sha8OfBytes`.
 */
async function sha256OfBytesFull(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const digest = await crypto.subtle.digest("SHA-256", buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}
