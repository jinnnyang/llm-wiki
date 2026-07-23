import { describe, it, expect, beforeEach, vi } from "vitest"

// Mock fs so the tests don't touch real disk. Follows the same pattern
// as `ingest-cache.test.ts` — the plan's §6 keeps DI narrow to
// `probeImageDimensions`; filesystem probes use module-level vi.mock.
vi.mock("@/commands/fs", () => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createDirectory: vi.fn(),
}))

import {
  MD_IMAGE_RE_WITH_TITLE,
  findImageReferencesWithTitle,
  classifyImageUrl,
  resolveLocalRelative,
  ALREADY_LOCALIZED_SUFFIX_RE,
  URL_CACHE_REL_PATH,
  readUrlCache,
  upsertUrlCacheEntry,
  isUrlCacheEntryFresh,
  sha8OfBytes,
  type UrlCacheEntry,
} from "./markdown-image-localizer"
import { fileExists, readFile, writeFile, createDirectory } from "@/commands/fs"

const mockFileExists = vi.mocked(fileExists)
const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)
const mockCreateDirectory = vi.mocked(createDirectory)

beforeEach(() => {
  mockFileExists.mockReset()
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockCreateDirectory.mockReset()
  mockWriteFile.mockResolvedValue(undefined as unknown as void)
  mockCreateDirectory.mockResolvedValue(undefined as unknown as void)
})

// ---------------------------------------------------------------------------
// Group A / Test 1 — MD_IMAGE_RE_WITH_TITLE
// ---------------------------------------------------------------------------

describe("MD_IMAGE_RE_WITH_TITLE — regex shapes (§7, Group A test 1)", () => {
  const runOnce = (input: string) => {
    const re = new RegExp(MD_IMAGE_RE_WITH_TITLE.source, "g")
    return re.exec(input)
  }

  it("matches ![](url) — no alt, no title", () => {
    const m = runOnce("prose ![](https://example.com/foo.png) prose")
    expect(m).not.toBeNull()
    expect(m![2]).toBe("") // alt
    expect(m![4]).toBe("https://example.com/foo.png") // url
    expect(m![6]).toBeUndefined() // title inner
  })

  it("matches ![alt](url) — alt, no title", () => {
    const m = runOnce("![diagram](../assets/x.png)")
    expect(m).not.toBeNull()
    expect(m![2]).toBe("diagram")
    expect(m![4]).toBe("../assets/x.png")
    expect(m![6]).toBeUndefined()
  })

  it("matches ![alt](url \"title\") — full form with double quotes", () => {
    const m = runOnce('![alt](https://x/y.png "the title")')
    expect(m).not.toBeNull()
    expect(m![2]).toBe("alt")
    expect(m![4]).toBe("https://x/y.png")
    expect(m![5]).toBe('"') // delimiter
    expect(m![6]).toBe("the title")
  })

  it("matches ![alt](url 'title') — single-quoted title", () => {
    const m = runOnce("![alt](https://x/y.png 'single quotes')")
    expect(m).not.toBeNull()
    expect(m![4]).toBe("https://x/y.png")
    expect(m![5]).toBe("'")
    expect(m![6]).toBe("single quotes")
  })

  it("matches ![alt with \\] fun](url) — escaped bracket in alt", () => {
    // Backslash-escaped `]` is a valid CommonMark alt character. Our
    // regex uses `(?:\\\]|[^\]])*` to admit it in the alt group.
    const m = runOnce("![alt with \\] fun](https://x/y.png)")
    expect(m).not.toBeNull()
    expect(m![2]).toBe("alt with \\] fun")
    expect(m![4]).toBe("https://x/y.png")
  })

  it("does NOT match <img> HTML tags (documented Phase 1 non-goal)", () => {
    const m = runOnce('<img src="https://x/y.png" alt="foo">')
    expect(m).toBeNull()
  })

  it("scanner returns all references in source order (integration of test 1)", () => {
    const md = [
      "Intro",
      "![](https://a.example/1.png)",
      "Middle text.",
      '![second](../two.png "two title")',
      "Tail with ![third](./three.png 'triple').",
    ].join("\n")
    const refs = findImageReferencesWithTitle(md)
    expect(refs).toHaveLength(3)
    expect(refs[0].url).toBe("https://a.example/1.png")
    expect(refs[0].alt).toBe("")
    expect(refs[0].title).toBeUndefined()
    expect(refs[1].url).toBe("../two.png")
    expect(refs[1].alt).toBe("second")
    expect(refs[1].title).toBe("two title")
    expect(refs[1].titleDelim).toBe('"')
    expect(refs[2].url).toBe("./three.png")
    expect(refs[2].title).toBe("triple")
    expect(refs[2].titleDelim).toBe("'")
    // Offsets are monotonic and valid slice anchors.
    for (const ref of refs) {
      expect(md.slice(ref.offset, ref.offset + ref.length)).toMatch(
        /^!\[[^\]]*\]\(/,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Group A / Test 2 — classifyImageUrl (§5)
// ---------------------------------------------------------------------------

describe("classifyImageUrl — 8 branches (§5, Group A test 2)", () => {
  const projectPath = "/project"
  const sourceDir = "/project/raw/sources"

  it("https:// → remote-http", async () => {
    const cls = await classifyImageUrl(
      "https://example.com/foo.png",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("remote-http")
  })

  it("http:// → remote-http", async () => {
    const cls = await classifyImageUrl(
      "http://example.com/foo.png",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("remote-http")
  })

  it("data:image/... → data-uri", async () => {
    const cls = await classifyImageUrl(
      "data:image/png;base64,iVBORw0KGgo=",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("data-uri")
  })

  it("../assets/x.png (file exists) → local-relative", async () => {
    // Relative path resolves inside project, file exists, NOT under
    // wiki/media/<slug>/<name>-<sha8> → local-relative.
    mockFileExists.mockResolvedValue(true)
    const cls = await classifyImageUrl(
      "../assets/x.png",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("local-relative")
    // Verify what path we probed — should have resolved
    // /project/raw/sources + ../assets/x.png → /project/raw/assets/x.png
    expect(mockFileExists).toHaveBeenCalledWith("/project/raw/assets/x.png")
  })

  it("../assets/missing.png (file doesn't exist) → failed", async () => {
    // Distinct from unsupported: relative path shape is well-formed
    // and stays inside project, but the target file isn't on disk.
    mockFileExists.mockResolvedValue(false)
    const cls = await classifyImageUrl(
      "../assets/missing.png",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("failed")
  })

  it("../../wiki/media/notes/foo-abc12345.png (file exists) → already-localized", async () => {
    mockFileExists.mockResolvedValue(true)
    const cls = await classifyImageUrl(
      "../../wiki/media/notes/foo-abc12345.png",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("already-localized")
    expect(mockFileExists).toHaveBeenCalledWith(
      "/project/wiki/media/notes/foo-abc12345.png",
    )
  })

  it("../../wiki/media/notes/foo-abc12345.png (file missing) → failed (§5 fall-through)", async () => {
    // Shape matches already-localized regex but file is missing. Per
    // §5 the classifier falls through to local-relative; local-relative
    // then requires the file to exist to avoid `failed`. Since the
    // file is missing on both branches, the final answer is `failed`.
    mockFileExists.mockResolvedValue(false)
    const cls = await classifyImageUrl(
      "../../wiki/media/notes/foo-abc12345.png",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("failed")
  })

  it("../../../../etc/passwd (path traversal) → failed (isInsideProject rejects)", async () => {
    // fileExists must NOT be called — we bail on the boundary check.
    const cls = await classifyImageUrl(
      "../../../../etc/passwd",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("failed")
    expect(mockFileExists).not.toHaveBeenCalled()
  })

  it("ftp://x/y → unsupported (documented Phase 1 non-goal)", async () => {
    const cls = await classifyImageUrl("ftp://x/y", sourceDir, projectPath)
    expect(cls).toBe("unsupported")
    expect(mockFileExists).not.toHaveBeenCalled()
  })

  it("mailto:foo@bar → unsupported OR failed (any non-http/data scheme)", async () => {
    // `mailto:` has no `//` so it doesn't match the generic scheme
    // regex; it falls through to local-relative resolution. Either
    // outcome (unsupported due to strict scheme sniff, or failed
    // because the resolved path doesn't exist) is acceptable — this
    // test locks in "not classified as remote-http/data-uri/etc".
    mockFileExists.mockResolvedValue(false)
    const cls = await classifyImageUrl(
      "mailto:foo@bar",
      sourceDir,
      projectPath,
    )
    expect(cls === "failed" || cls === "unsupported").toBe(true)
  })

  it("data:text/plain;... → unsupported (non-image data URI)", async () => {
    const cls = await classifyImageUrl(
      "data:text/plain;base64,SGVsbG8=",
      sourceDir,
      projectPath,
    )
    expect(cls).toBe("unsupported")
  })
})

// ---------------------------------------------------------------------------
// Supporting: resolveLocalRelative + ALREADY_LOCALIZED_SUFFIX_RE
// ---------------------------------------------------------------------------

describe("resolveLocalRelative — path resolution + boundary check (§5, §4)", () => {
  it("resolves ../assets/x.png against /project/raw/sources → /project/raw/assets/x.png (inside)", () => {
    const r = resolveLocalRelative(
      "../assets/x.png",
      "/project/raw/sources",
      "/project",
    )
    expect(r.absPath).toBe("/project/raw/assets/x.png")
    expect(r.insideProject).toBe(true)
  })

  it("resolves ./same-dir.png against /project/raw/sources → /project/raw/sources/same-dir.png", () => {
    const r = resolveLocalRelative(
      "./same-dir.png",
      "/project/raw/sources",
      "/project",
    )
    expect(r.absPath).toBe("/project/raw/sources/same-dir.png")
    expect(r.insideProject).toBe(true)
  })

  it("resolves ../../wiki/media/slug/foo-abcdef01.png → /project/wiki/media/slug/foo-abcdef01.png", () => {
    const r = resolveLocalRelative(
      "../../wiki/media/slug/foo-abcdef01.png",
      "/project/raw/sources",
      "/project",
    )
    expect(r.absPath).toBe("/project/wiki/media/slug/foo-abcdef01.png")
    expect(r.insideProject).toBe(true)
  })

  it("flags escape-attempts as outside project", () => {
    const r = resolveLocalRelative(
      "../../../../etc/passwd",
      "/project/raw/sources",
      "/project",
    )
    expect(r.insideProject).toBe(false)
  })
})

describe("ALREADY_LOCALIZED_SUFFIX_RE — matches only the localized shape", () => {
  it("matches wiki/media/<slug>/<name>-<sha8>.<ext>", () => {
    expect(
      ALREADY_LOCALIZED_SUFFIX_RE.test(
        "/project/wiki/media/notes/foo-abc12345.png",
      ),
    ).toBe(true)
    expect(
      ALREADY_LOCALIZED_SUFFIX_RE.test(
        "/project/wiki/media/deep-slug/some-name-01234567.webp",
      ),
    ).toBe(true)
  })

  it("rejects paths without the -<sha8> suffix", () => {
    expect(
      ALREADY_LOCALIZED_SUFFIX_RE.test("/project/wiki/media/notes/foo.png"),
    ).toBe(false)
  })

  it("rejects paths outside wiki/media/", () => {
    expect(
      ALREADY_LOCALIZED_SUFFIX_RE.test(
        "/project/raw/assets/foo-abc12345.png",
      ),
    ).toBe(false)
  })

  it("rejects a wrong sha8 length", () => {
    expect(
      ALREADY_LOCALIZED_SUFFIX_RE.test(
        "/project/wiki/media/notes/foo-abc123.png", // 6 chars, not 8
      ),
    ).toBe(false)
    expect(
      ALREADY_LOCALIZED_SUFFIX_RE.test(
        "/project/wiki/media/notes/foo-abc1234567.png", // 10 chars, not 8
      ),
    ).toBe(false)
  })

  it("rejects uppercase hex in sha8 (we always write lowercase)", () => {
    expect(
      ALREADY_LOCALIZED_SUFFIX_RE.test(
        "/project/wiki/media/notes/foo-ABC12345.png",
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// URL cache — data layer (Commit 3b; §3.2)
// ---------------------------------------------------------------------------

/** Sample entry used across the URL cache tests. */
const sampleEntry: UrlCacheEntry = {
  sha256: "0123456789abcdef".repeat(4),
  mimeType: "image/png",
  width: 640,
  height: 480,
  bytesLen: 12345,
  fetchedAt: "2026-07-23T00:00:00.000Z",
  canonicalRelPath: "wiki/media/slug/logo-01234567.png",
}

describe("readUrlCache — corrupt-tolerant loader (§Risk #5)", () => {
  it("returns empty map when the cache file does not exist", async () => {
    mockFileExists.mockResolvedValue(false)
    const out = await readUrlCache("/project")
    expect(out).toEqual({})
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it("probes the exact cache path at .llm-wiki/image-url-cache.json", async () => {
    mockFileExists.mockResolvedValue(false)
    await readUrlCache("/project")
    expect(mockFileExists).toHaveBeenCalledWith(`/project/${URL_CACHE_REL_PATH}`)
  })

  it("returns the parsed cache on a well-formed JSON object", async () => {
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue(
      JSON.stringify({ "https://x/y.png": sampleEntry }),
    )
    const out = await readUrlCache("/project")
    expect(out).toEqual({ "https://x/y.png": sampleEntry })
  })

  it("warns and returns empty when JSON is malformed (recover, don't wedge)", async () => {
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue("{ not really json")
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const out = await readUrlCache("/project")
    expect(out).toEqual({})
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("returns empty when the parsed value isn't a plain object (e.g. an array)", async () => {
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue(JSON.stringify(["not", "a", "map"]))
    const out = await readUrlCache("/project")
    expect(out).toEqual({})
  })

  it("returns empty when the parsed value is null", async () => {
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue("null")
    const out = await readUrlCache("/project")
    expect(out).toEqual({})
  })
})

describe("upsertUrlCacheEntry — per-key merge write (§3.2 concurrency note)", () => {
  it("writes the new entry when the cache didn't exist", async () => {
    mockFileExists.mockResolvedValue(false)
    await upsertUrlCacheEntry("/project", "https://a/1.png", sampleEntry)
    expect(mockCreateDirectory).toHaveBeenCalledWith("/project/.llm-wiki")
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    const [path, body] = mockWriteFile.mock.calls[0]
    expect(path).toBe(`/project/${URL_CACHE_REL_PATH}`)
    expect(JSON.parse(body)).toEqual({ "https://a/1.png": sampleEntry })
  })

  it("preserves other keys when merging a new key into an existing cache", async () => {
    const existing = { "https://a/1.png": sampleEntry }
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue(JSON.stringify(existing))
    const secondEntry: UrlCacheEntry = {
      ...sampleEntry,
      sha256: "ffff".repeat(16),
      canonicalRelPath: "wiki/media/slug/other-abcd1234.png",
    }
    await upsertUrlCacheEntry("/project", "https://b/2.png", secondEntry)
    const written = JSON.parse(mockWriteFile.mock.calls[0][1])
    expect(written).toEqual({
      "https://a/1.png": sampleEntry,
      "https://b/2.png": secondEntry,
    })
  })

  it("overwrites the same key with the new entry (TTL bump path)", async () => {
    const stale: UrlCacheEntry = {
      ...sampleEntry,
      fetchedAt: "2025-01-01T00:00:00.000Z",
    }
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue(
      JSON.stringify({ "https://x/y.png": stale }),
    )
    await upsertUrlCacheEntry("/project", "https://x/y.png", sampleEntry)
    const written = JSON.parse(mockWriteFile.mock.calls[0][1])
    expect(written).toEqual({ "https://x/y.png": sampleEntry })
  })

  it("recovers from a corrupt cache — treats it as empty and writes just the new entry", async () => {
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue("<< not json >>")
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    await upsertUrlCacheEntry("/project", "https://x/y.png", sampleEntry)
    spy.mockRestore()
    const written = JSON.parse(mockWriteFile.mock.calls[0][1])
    expect(written).toEqual({ "https://x/y.png": sampleEntry })
  })
})

// ---------------------------------------------------------------------------
// isUrlCacheEntryFresh — TTL helper (§3.2)
// ---------------------------------------------------------------------------

describe("isUrlCacheEntryFresh — 45-day default TTL semantics", () => {
  const day = 24 * 60 * 60 * 1000
  const now = Date.parse("2026-07-23T00:00:00.000Z")

  it("returns true when fetched an hour ago", () => {
    const entry = { fetchedAt: new Date(now - 60 * 60 * 1000).toISOString() }
    expect(isUrlCacheEntryFresh(entry, 45, now)).toBe(true)
  })

  it("returns true right up to the TTL boundary (inclusive)", () => {
    const entry = { fetchedAt: new Date(now - 45 * day).toISOString() }
    expect(isUrlCacheEntryFresh(entry, 45, now)).toBe(true)
  })

  it("returns false one millisecond past the TTL boundary", () => {
    const entry = { fetchedAt: new Date(now - 45 * day - 1).toISOString() }
    expect(isUrlCacheEntryFresh(entry, 45, now)).toBe(false)
  })

  it("returns false for a fetch older than 45 days when ttlDays=45", () => {
    const entry = { fetchedAt: new Date(now - 100 * day).toISOString() }
    expect(isUrlCacheEntryFresh(entry, 45, now)).toBe(false)
  })

  it("returns true when fetchedAt is in the future (clock-skew tolerance)", () => {
    const entry = { fetchedAt: new Date(now + 5 * day).toISOString() }
    expect(isUrlCacheEntryFresh(entry, 45, now)).toBe(true)
  })

  it("returns false when fetchedAt is malformed (safer: force re-fetch)", () => {
    expect(isUrlCacheEntryFresh({ fetchedAt: "not a date" }, 45, now)).toBe(false)
    expect(isUrlCacheEntryFresh({ fetchedAt: "" }, 45, now)).toBe(false)
  })

  it("respects a caller-supplied TTL of 0 (no freshness — every entry stale except right now)", () => {
    // Exactly `now` still counts as fresh (0ms age ≤ 0ms TTL).
    const entry = { fetchedAt: new Date(now).toISOString() }
    expect(isUrlCacheEntryFresh(entry, 0, now)).toBe(true)
    // 1ms older → stale.
    const older = { fetchedAt: new Date(now - 1).toISOString() }
    expect(isUrlCacheEntryFresh(older, 0, now)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// sha8OfBytes — filename disambiguator
// ---------------------------------------------------------------------------

describe("sha8OfBytes — 8-char lowercase hex prefix", () => {
  it("returns exactly 8 hex chars", async () => {
    const hex = await sha8OfBytes(new Uint8Array([1, 2, 3, 4]))
    expect(hex).toMatch(/^[0-9a-f]{8}$/)
  })

  it("is deterministic for the same input bytes", async () => {
    const a = await sha8OfBytes(new Uint8Array([9, 9, 9]))
    const b = await sha8OfBytes(new Uint8Array([9, 9, 9]))
    expect(a).toBe(b)
  })

  it("matches the SHA-256 prefix of the input (known vector)", async () => {
    // SHA-256 of the ASCII bytes for "abc" is
    //   ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    // → prefix "ba7816bf".
    const bytes = new TextEncoder().encode("abc")
    const hex = await sha8OfBytes(bytes)
    expect(hex).toBe("ba7816bf")
  })

  it("distinguishes distinct inputs (near-input collision would be a red flag)", async () => {
    const a = await sha8OfBytes(new Uint8Array([0]))
    const b = await sha8OfBytes(new Uint8Array([1]))
    expect(a).not.toBe(b)
  })
})
