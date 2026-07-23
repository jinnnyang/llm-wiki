import { describe, it, expect, beforeEach, vi } from "vitest"

// Mock fs so the tests don't touch real disk. Follows the same pattern
// as `ingest-cache.test.ts` — the plan's §6 keeps DI narrow to
// `probeImageDimensions`; filesystem probes use module-level vi.mock.
vi.mock("@/commands/fs", () => ({
  fileExists: vi.fn(),
}))

import {
  MD_IMAGE_RE_WITH_TITLE,
  findImageReferencesWithTitle,
  classifyImageUrl,
  resolveLocalRelative,
  ALREADY_LOCALIZED_SUFFIX_RE,
} from "./markdown-image-localizer"
import { fileExists } from "@/commands/fs"

const mockFileExists = vi.mocked(fileExists)

beforeEach(() => {
  mockFileExists.mockReset()
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
