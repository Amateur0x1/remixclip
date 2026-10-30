#!/usr/bin/env tsx
/**
 * [INPUT]: apps/web/src/i18n dictionaries and locale list, sources under apps/web,
 *   apps/web/i18n-allowlist.json.
 * [OUTPUT]: Dictionary completeness / placeholder consistency check + scan of bare Chinese
 *   in sources (including an attribute-specific pass); non-zero exit code on failure.
 * [POS]: The i18n gate shared by CI and local: `pnpm i18n:check` (fails) /
 *   `-- --coverage` (stats only).
 *
 * Checks:
 *   a) LOCALES / LOCALE_LABEL / per-locale dictionary exports expose the same key set;
 *   b) every locale dictionary's key set exactly matches the canonical (zh-CN) one;
 *   c) each key's `{name}` placeholder set matches across locales;
 *   d) bare Chinese scan of sources (.ts/.tsx, excluding locales, comments, allowlist);
 *   e) attribute pass: Chinese left in aria-label / title / placeholder / alt … is
 *      reported separately.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICTS } from '../apps/web/src/i18n/locales/index';
import { DEFAULT_LOCALE, LOCALES, LOCALE_LABEL, type Locale } from '../apps/web/src/i18n/types';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_ROOTS = ['apps/web/src', 'apps/web/app'] as const;
const SCAN_EXTS = new Set(['.ts', '.tsx']);
/** Dictionaries are necessarily all Chinese, so they are excluded from the source scan. */
const SCAN_EXCLUDE = ['apps/web/src/i18n/locales/'];
const ALLOWLIST_PATH = 'apps/web/i18n-allowlist.json';

// ── Chinese detection ────────────────────────────────────────────────────
// CJK unified ideographs + Chinese punctuation + fullwidth forms: missing punctuation
// would let leftovers such as "Cancel，" (English text followed by a full-width comma) slip through.
const CHINESE = /[\u3000-\u303f\u4e00-\u9fff\uff01-\uff60]/;

/** Whole-line comment: `//` line comment, block-comment continuation `*`, block-comment
 * opener, JSX comment `{/*`. */
const COMMENT_ONLY_LINE = /^(\/\/|\/\*|\*\/?|\{\/\*)/;

/**
 * Find "comment lines": whole-line comments, plus every continuation line of a block
 * that starts at `/*` (including `{/*`) and runs across multiple lines until `*` closes it.
 * Checking each raw line is enough — steadier than a state machine, and it never mistakes
 * a `//` inside a string for a real comment.
 */
function multilineCommentLines(rawLines: string[]): Set<number> {
  const commentLines = new Set<number>();
  let openBlock = false;
  rawLines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (openBlock) {
      commentLines.add(index);
      if (trimmed.includes('*/')) openBlock = false;
      return;
    }
    const startsBlock = /^(\/\*|\{\/\*)/.test(trimmed);
    if (COMMENT_ONLY_LINE.test(trimmed)) commentLines.add(index);
    if (startsBlock && !trimmed.includes('*/')) openBlock = true;
  });
  return commentLines;
}

// ── Comment stripping (keeps newlines and offsets, line numbers unchanged) ──────
/**
 * Replace comment characters with spaces while strings/templates stay intact — Chinese
 * inside strings is exactly what we want to catch, but Chinese inside comments must pass.
 * The state machine spans lines, so the whole source is scanned once instead of line regexes.
 */
function maskComments(source: string): string {
  const chars = source.split('');
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex';
  let state: State = 'code';
  /** The previous "significant" code character: separates division from a regex literal's slash. */
  let lastSignificant = '';
  /** Trailing identifier: after keywords such as `return /re/` the slash starts a regex,
   * not a division. */
  let word = '';
  const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await']);
  /** Whether we are inside a regex literal's character class `[...]` (quotes/slashes there
   * are not syntax). */
  let inClass = false;

  const valueEnd = /[\w$)\]}]/;

  const mask = (index: number): void => {
    if (chars[index] !== '\n') chars[index] = ' ';
  };

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    const next = chars[i + 1];
    switch (state) {
      case 'code': {
        if (ch === '/' && next === '/') {
          mask(i);
          mask(i + 1);
          i += 1;
          state = 'line';
          break;
        }
        if (ch === '/' && next === '*') {
          mask(i);
          mask(i + 1);
          i += 1;
          state = 'block';
          break;
        }
        if (ch === '/') {
          // A `/` after a division sign cannot start a regex; other contexts (`(`, `=`, `,`,
          // `return` …) are treated as regex, otherwise quotes inside a class such as
          // `['"]` would make the rest of the code look like a string.
          if (lastSignificant === '' || !valueEnd.test(lastSignificant) || REGEX_KEYWORDS.has(word)) {
            state = 'regex';
            inClass = false;
            break;
          }
        }
        if (ch === "'") state = 'single';
        else if (ch === '"') state = 'double';
        else if (ch === '`') state = 'template';
        if (!/\s/.test(ch)) lastSignificant = ch;
        word = /[\w$]/.test(ch) ? word + ch : '';
        break;
      }
      case 'line':
        if (ch === '\n') state = 'code';
        else mask(i);
        break;
      case 'block':
        if (ch === '*' && next === '/') {
          mask(i);
          mask(i + 1);
          i += 1;
          state = 'code';
        } else mask(i);
        break;
      case 'regex':
        if (ch === '\\') i += 1;
        else if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) {
          state = 'code';
          lastSignificant = '/';
        }
        break;
      case 'single':
      case 'double':
      case 'template':
        if (ch === '\\') i += 1;
        else if (
          (state === 'single' && ch === "'") ||
          (state === 'double' && ch === '"') ||
          (state === 'template' && ch === '`')
        ) {
          state = 'code';
          lastSignificant = ch;
        }
        break;
    }
  }
  return chars.join('');
}

interface AllowEntry {
  file: string;
  /** Optional exact snippet: allow only this one occurrence instead of the whole file. */
  text?: string;
  reason: string;
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function loadAllowlist(): { entries: AllowEntry[]; errors: string[] } {
  const path = join(ROOT, ALLOWLIST_PATH);
  if (!existsSync(path)) return { entries: [], errors: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { allow?: AllowEntry[] };
    const entries = parsed.allow ?? [];
    const errors = entries
      .filter((entry) => !entry.reason || !entry.reason.trim())
      .map((entry) => `${ALLOWLIST_PATH}: entry for "${entry.file}"${entry.text ? ` ("${entry.text}")` : ''} is missing a reason`);
    return { entries, errors };
  } catch (error) {
    return { entries: [], errors: [`${ALLOWLIST_PATH}: cannot be parsed (${(error as Error).message})`] };
  }
}

function isAllowed(entry: AllowEntry[], file: string, text: string): boolean {
  return entry.some((item) => item.file === file && (!item.text || text.includes(item.text)));
}

// ── a/b/c: dictionary structure ────────────────────────────────────────────
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

function sameSet(a: Iterable<string>, b: Iterable<string>): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function checkDictionaries(): { failures: string[]; keyTotal: number; coverage: Record<string, number> } {
  const failures: string[] = [];

  const localeKeys = LOCALES.map((locale) => locale);
  const labelKeys = Object.keys(LOCALE_LABEL);
  const dictKeys = Object.keys(DICTS);
  if (!sameSet(localeKeys, labelKeys)) {
    failures.push(`LOCALES [${localeKeys.join(', ')}] vs LOCALE_LABEL [${labelKeys.join(', ')}]: key sets differ`);
  }
  if (!sameSet(localeKeys, dictKeys)) {
    failures.push(`LOCALES [${localeKeys.join(', ')}] vs DICTS [${dictKeys.join(', ')}]: key sets differ`);
  }

  const canonical = DICTS[DEFAULT_LOCALE] as Record<string, string>;
  const canonicalKeys = Object.keys(canonical);
  const coverage: Record<string, number> = {};

  for (const locale of LOCALES) {
    const dict = DICTS[locale] as Record<string, string>;
    const keys = Object.keys(dict);
    const missing = canonicalKeys.filter((key) => !(key in dict));
    const extra = keys.filter((key) => !(key in canonical));
    if (missing.length) {
      failures.push(`[${locale}] missing ${missing.length} key(s) present in ${DEFAULT_LOCALE}: ${missing.join(', ')}`);
    }
    if (extra.length) {
      failures.push(`[${locale}] has ${extra.length} key(s) absent from ${DEFAULT_LOCALE}: ${extra.join(', ')}`);
    }
    coverage[locale] = canonicalKeys.length === 0
      ? 100
      : Math.round(((canonicalKeys.length - missing.length) / canonicalKeys.length) * 1000) / 10;

    for (const key of canonicalKeys) {
      const translated = dict[key];
      if (typeof translated !== 'string') continue;
      const expected = placeholders(canonical[key] ?? '');
      const actual = placeholders(translated);
      if (!sameSet(expected, actual)) {
        failures.push(`[${locale}] "${key}": placeholders {${expected.join('}, {') || '—'}} ≠ {${actual.join('}, {') || '—'}}`);
      }
    }
  }

  return { failures, keyTotal: canonicalKeys.length, coverage };
}

// ── d/e: source scan ───────────────────────────────────────────────────────
function walk(dir: string, files: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else if (SCAN_EXTS.has(name.slice(name.lastIndexOf('.')))) files.push(full);
  }
}

const ATTRIBUTE = /\b(aria-label|aria-description|aria-placeholder|aria-roledescription|title|placeholder|alt|label)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\{\s*`(?:[^`\\]|\\.)*`\s*\})/g;

interface ScanResult {
  files: number;
  bare: Hit[];
  attributes: Hit[];
}

function scanSources(allow: AllowEntry[]): ScanResult {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(ROOT, root), files);

  const result: ScanResult = { files: 0, bare: [], attributes: [] };
  for (const absolute of files) {
    const repoPath = relative(ROOT, absolute).split('\\').join('/');
    if (SCAN_EXCLUDE.some((prefix) => repoPath.startsWith(prefix))) continue;
    result.files += 1;

    const raw = readFileSync(absolute, 'utf8');
    const masked = maskComments(raw);
    const lines = masked.split('\n');
    const rawLines = raw.split('\n');
    const commentLines = multilineCommentLines(rawLines);
    lines.forEach((line, index) => {
      if (!CHINESE.test(line)) return;
      // Line-level fallback: if the whole line is a comment (including block-comment
      // continuations and JSX comments), always let it pass. The state machine misses
      // comment stripping in a few nested-quote cases; this guarantees "Chinese inside
      // comments" is never mis-reported.
      if (commentLines.has(index)) return;
      const snippet = line.trim().slice(0, 120);
      if (!isAllowed(allow, repoPath, snippet)) {
        result.bare.push({ file: repoPath, line: index + 1, text: snippet });
      }
    });

    // Attribute pass: its own rule; errors point at file:line (also subject to the allowlist)
    let match: RegExpExecArray | null;
    ATTRIBUTE.lastIndex = 0;
    while ((match = ATTRIBUTE.exec(masked)) !== null) {
      if (!CHINESE.test(match[2]!)) continue;
      const line = masked.slice(0, match.index).split('\n').length;
      const snippet = match[0].replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!isAllowed(allow, repoPath, snippet)) {
        result.attributes.push({ file: repoPath, line, text: snippet });
      }
    }
  }
  return result;
}

// ── Output ─────────────────────────────────────────────────────────────────
function groupByFile(hits: Hit[]): Map<string, Hit[]> {
  const grouped = new Map<string, Hit[]>();
  for (const hit of hits) {
    const list = grouped.get(hit.file) ?? [];
    list.push(hit);
    grouped.set(hit.file, list);
  }
  return grouped;
}

function printHits(title: string, hits: Hit[]): void {
  if (hits.length === 0) return;
  console.error(`\n✗ ${title} (${hits.length})`);
  for (const [file, items] of groupByFile(hits)) {
    console.error(`  ${file}`);
    for (const item of items) console.error(`    ${file}:${item.line}  ${item.text}`);
  }
}

function localeCoverageLine(keyTotal: number, coverage: Record<string, number>): string {
  return LOCALES.map((locale: Locale) => `${locale} ${coverage[locale] ?? 0}%`).join('  ·  ') + `   (keys: ${keyTotal})`;
}

function main(): void {
  const coverageOnly = process.argv.includes('--coverage');
  const { entries, errors: allowErrors } = loadAllowlist();
  const { failures, keyTotal, coverage } = checkDictionaries();
  const scan = scanSources(entries);

  if (coverageOnly) {
    console.log(`i18n coverage: ${localeCoverageLine(keyTotal, coverage)}`);
    console.log(`dictionary mismatches: ${failures.length}`);
    console.log(`source files scanned: ${scan.files}`);
    console.log(`bare Chinese hits: ${scan.bare.length}`);
    console.log(`attribute hits (aria-*/title/placeholder/alt): ${scan.attributes.length}`);
    for (const [file, items] of groupByFile(scan.bare)) {
      console.log(`  ${file}: ${items.length}`);
    }
    process.exit(0);
  }

  for (const failure of failures) console.error(`✗ ${failure}`);
  for (const error of allowErrors) console.error(`✗ ${error}`);
  printHits('bare Chinese in source (move to the dictionary)', scan.bare);
  printHits('Chinese left in translated attributes', scan.attributes);

  const failed = failures.length + allowErrors.length + scan.bare.length + scan.attributes.length;
  if (failed > 0) {
    console.error(`\ni18n check failed: ${failures.length} dictionary issue(s), ${scan.bare.length} bare string(s), ${scan.attributes.length} attribute(s).`);
    process.exit(1);
  }

  console.log('i18n check passed');
  console.log(`  languages:        ${LOCALES.join(', ')}`);
  console.log(`  coverage:         ${localeCoverageLine(keyTotal, coverage)}`);
  console.log(`  files scanned:    ${scan.files}`);
  console.log(`  bare Chinese:     0`);
  console.log(`  attribute hits:   0`);
  console.log(`  allowlist:        ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
}

main();
