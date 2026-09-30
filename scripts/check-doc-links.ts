#!/usr/bin/env node
/**
 * Relative-link checker for README.md and every docs/ Markdown file (issue #78).
 *
 * It walks every Markdown link/image target in those files and, for targets
 * that point *inside* the repo, asserts the referenced path exists on disk.
 *
 * Only relative links are checked on purpose. Fetching external URLs in CI
 * would make the gate flaky for reasons this repo does not own — rate limits,
 * transient 5xx, offline shared runners — and turn a documentation edit into a
 * network test. The files in this repo are the only thing a contributor can
 * actually break with a broken link, so they are the only thing checked.
 *
 * Relative targets are resolved against the directory of the file that contains
 * them, so `docs/**` links using `../` are handled the same as root-relative
 * README links. A trailing `/` must resolve to a directory; anything else must
 * resolve to an existing file or directory. URL fragments (`#anchor`) are
 * stripped and only the file is verified — heading targets are not parsed.
 *
 * Dependency-free: Node built-ins only (`npm run check:docs`).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DOCS_DIR = join(REPO_ROOT, "docs");

const MARKDOWN_LINK = /!?\[[^\]]*\]\(([^)]+)\)/g;

const EXTERNAL_OR_ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i;

interface ScanResult {
  readonly files: number;
  readonly links: number;
  readonly broken: readonly BrokenLink[];
}

interface BrokenLink {
  readonly file: string;
  readonly target: string;
}

function collectDocsFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectDocsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Strip the parts of a Markdown document where a `](...)` sequence is not a
 * link: fenced code blocks, inline code spans, and HTML comments. The README
 * keeps a commented-out `[Documentation](...)` placeholder, which would
 * otherwise read as a link to a file literally named "...".
 */
function stripNonLinkRegions(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/`[^`\n]*`/g, "");
}

function normalizeTarget(rawTarget: string): string | null {
  let target = rawTarget.trim();

  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  }

  if (!target) {
    return null;
  }

  // Drop a Markdown link title: `path "Title"` -> `path`.
  const firstToken = target.split(/[ \t]/)[0];
  if (!firstToken) {
    return null;
  }
  target = firstToken;

  // External, protocol-relative, and site-absolute URLs are out of scope.
  if (EXTERNAL_OR_ABSOLUTE.test(target)) {
    return null;
  }

  // Anchor-only links stay on the same page; nothing on disk to check.
  const hashIndex = target.indexOf("#");
  if (hashIndex !== -1) {
    target = target.slice(0, hashIndex);
  }
  if (!target) {
    return null;
  }

  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function checkFile(file: string, broken: BrokenLink[]): { links: number } {
  const markdown = stripNonLinkRegions(readFileSync(file, "utf8"));
  const baseDir = dirname(file);
  let links = 0;

  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    const rawTarget = match[1];
    if (rawTarget === undefined) {
      continue;
    }

    const target = normalizeTarget(rawTarget);
    if (target === null) {
      continue;
    }

    links += 1;

    const absolute = resolve(baseDir, target);
    const wantsDirectory = target.endsWith("/");
    const exists = existsSync(absolute);
    const resolves = exists && (!wantsDirectory || statSync(absolute).isDirectory());

    if (!resolves) {
      broken.push({ file: relativePath(file), target: rawTarget.trim() });
    }
  }

  return { links };
}

function relativePath(file: string): string {
  const prefix = REPO_ROOT + "/";
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

function scan(): ScanResult {
  const files = [join(REPO_ROOT, "README.md"), ...collectDocsFiles(DOCS_DIR)];
  const broken: BrokenLink[] = [];
  let links = 0;

  for (const file of files) {
    links += checkFile(file, broken).links;
  }

  return { files: files.length, links, broken };
}

const result = scan();

if (result.broken.length > 0) {
  console.error(
    `Relative link check FAILED: ${result.broken.length} broken link(s) across ${result.files} file(s):\n`,
  );
  for (const { file, target } of result.broken) {
    console.error(`  ${file} -> ${target}`);
  }
  process.exit(1);
}

console.log(
  `Relative link check passed: ${result.links} relative link(s) across ${result.files} file(s).`,
);
