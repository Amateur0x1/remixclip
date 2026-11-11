/** isTodoWriteToolName in the OD contract: exact-name match (remixclip doesn't export that contract, local same-convention implementation) */
const TODO_WRITE_TOOL_NAMES = new Set(['TodoWrite', 'Todowrite', 'todo_write']);

/**
 * The semantics of a tool row: what this particular call is actually doing.
 *
 * Why the tool name alone isn't enough (D7 / spec §2.1):
 * OD's skill guidance makes agents stuff reading, searching and querying into `Bash` —— in real
 * recordings claude did 84 `Bash` / 8 `Read` in one turn; codex's 14 commands were all called
 * `Bash` and had no description.
 * Classifying by tool name would collapse the whole column into "run command". So we have to sniff
 * the content of `command`.
 *
 * Changing the skill to make agents use dedicated tools was rejected (D7): the skill is product
 * behavior, with a much larger blast radius than changing the UI. The cost is that the rules here
 * have to evolve with agent habits —— which is why they must have tests.
 *
 * The original 9 recorded commands are still in the regression set; on 2026-08-28 we did a
 * read-only supplementary sample of 332 commands from local stable / beta / prerelease sessions,
 * pinning down only provable syntactic shapes.
 */

/** Verbs in the UI: read / create / edit / delete / search / exec / generate; unrecognized ones
 * show the tool name as-is (T4) */
export type ToolKind = 'read' | 'write' | 'edit' | 'delete' | 'search' | 'exec' | 'image' | 'other';

type CommandKind = Exclude<ToolKind, 'image' | 'other'>;
type ClassifiedKind = CommandKind | 'noise';

const READ = /^(cat|head|tail|less|more|sed|awk|jq|wc|nl|stat|file|du|diff|pwd)$/;
const SEARCH = /^(grep|rg|egrep|find|fd|ls|tree|locate|which)$/;
const WRITE = /^(tee|touch|mkdir|cp|install)$/;
const EDIT = /^(mv|ln|chmod|patch|apply_patch)$/;
const DELETE = /^(rm|rmdir|unlink)$/;
/** These commands don't state intent by themselves (`cd`, `echo`); only when the whole command is
 * just them do we fall back to "exec" */
const NOISE = /^(echo|printf|true|false|cd|export|set)$/;

const RANK: Record<ClassifiedKind, number> = {
  delete: 6,
  edit: 5,
  write: 4,
  read: 3,
  search: 2,
  exec: 1,
  noise: 0,
};

/**
 * codex wraps every command as `/bin/zsh -lc '…'` (pitfall #16: not stripping the shell wrapper
 * made all 14 commands classify as "run"). Strip at most two layers; if the closing quote doesn't
 * match (mixed quotes in the command) we still strip —— better to over-strip than not strip.
 */
export function unwrapShell(command: string): string {
  let c = String(command ?? '').trim();
  for (let i = 0; i < 2; i += 1) {
    const m = c.match(/^(?:\/bin\/|\/usr\/bin\/)?(?:sh|bash|zsh|dash)\s+(?:-[a-zA-Z]+\s+)*(['"])([\s\S]*)$/);
    if (!m) break;
    const quote = m[1] ?? '';
    let inner = m[2] ?? '';
    if (quote && inner.endsWith(quote)) inner = inner.slice(0, -1);
    c = inner.trim();
  }
  return c;
}

interface SimpleCommand {
  text: string;
  words: string[];
  headIndex: number;
  token: string;
}

interface CommandAnalysis {
  kind: ClassifiedKind;
  segment: SimpleCommand | null;
  inlineTarget?: string;
}

/**
 * Only split on connectors at the shell top level. 78 commands in the local sessions contain
 * `>` / `|` / `;` inside quoted content, and splitting directly with a regex would treat search
 * patterns and HTML fragments as shell syntax.
 */
function splitTopLevel(input: string, mode: 'groups' | 'pipes'): string[] {
  const out: string[] = [];
  let start = 0;
  let quote = '';
  let escaped = false;
  const push = (end: number, width: number) => {
    const part = input.slice(start, end).trim();
    if (part) out.push(part);
    start = end + width;
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? '';
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }

    if (mode === 'groups') {
      const pair = input.slice(i, i + 2);
      if (pair === '&&' || pair === '||') { push(i, 2); i += 1; continue; }
      if (ch === ';' || ch === '\n') { push(i, 1); continue; }
    } else if (ch === '|' && input[i + 1] !== '|') {
      push(i, 1);
    }
  }
  push(input.length, 0);
  return out;
}

/** A heredoc body is Python / JS / HTML and must not be split as shell. Shell analysis only looks
 * at the opening line. */
function shellPrelude(command: string): string {
  const firstNewline = command.indexOf('\n');
  if (firstNewline < 0) return command;
  const first = command.slice(0, firstNewline);
  return /<<-?\s*["']?[A-Za-z_][\w-]*/.test(first) ? first : command;
}

/** Shell words of one simple command; only classification and single-file targets need support,
 * we neither execute nor attempt a full shell AST parse. */
function shellWords(input: string): string[] {
  const out: string[] = [];
  let word = '';
  let quote = '';
  let escaped = false;
  let started = false;
  const push = () => {
    if (started) out.push(word);
    word = '';
    started = false;
  };
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? '';
    if (escaped) { word += ch; started = true; escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (ch === quote) quote = '';
      else word += ch;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) { push(); continue; }
    word += ch;
    started = true;
  }
  if (escaped) word += '\\';
  push();
  return out;
}

function commandHeadIndex(words: string[]): number {
  let i = 0;
  while (i < words.length && /^\w+=/.test(words[i] ?? '')) i += 1;
  while (i < words.length) {
    const prefix = basename(words[i] ?? '');
    if (!/^(sudo|env|command|nohup|time)$/.test(prefix)) break;
    const prefixIndex = i;
    i += 1;
    while (i < words.length && (words[i] ?? '').startsWith('-')) i += 1;
    while (i < words.length && /^\w+=/.test(words[i] ?? '')) i += 1;
    // In `env | rg ...` env is a data source, not a prefix without a following command.
    if (i >= words.length) return prefixIndex;
  }
  return i;
}

function simpleCommand(text: string): SimpleCommand {
  const words = shellWords(text);
  const headIndex = commandHeadIndex(words);
  const raw = words[headIndex] ?? '';
  const token = raw.startsWith('$') ? '$VAR' : basename(raw);
  return { text, words, headIndex, token };
}

function classifyToken(token: string, words: readonly string[], headIndex: number): ClassifiedKind {
  if (token === '$VAR') return 'exec';
  if (NOISE.test(token)) return 'noise';
  const args = words.slice(headIndex + 1);
  if (token === 'sed' && args.some((arg) => arg === '-i' || /^-i.+/.test(arg))) return 'edit';
  if (token === 'perl' && args.some((arg) => /^-[^-]*p[^-]*i|^-[^-]*i[^-]*p/.test(arg))) return 'edit';
  if (DELETE.test(token)) return 'delete';
  if (EDIT.test(token)) return 'edit';
  if (READ.test(token)) return 'read';
  if (SEARCH.test(token)) return 'search';
  if (WRITE.test(token)) return 'write';
  return 'exec';
}

/** Find real output redirections, ignoring `>` inside quotes and fd control like `2>&1` /
 * `2>/dev/null`. */
function outputRedirectionTargets(segment: string): string[] {
  const out: string[] = [];
  let quote = '';
  let escaped = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i] ?? '';
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch !== '>') continue;
    if (segment[i - 1] === '>') continue;
    if (/\d/.test(segment[i - 1] ?? '')) continue;
    const append = segment[i + 1] === '>';
    let j = i + (append ? 2 : 1);
    while (/\s/.test(segment[j] ?? '')) j += 1;
    if (segment[j] === '&') continue;
    const words = shellWords(segment.slice(j));
    const target = words[0];
    if (target) out.push(target);
    if (append) i += 1;
  }
  return out;
}

interface InlineScriptMutation { kind: 'write' | 'edit' | 'delete'; target?: string }

/**
 * Real OD sessions often use Python / Node heredocs for small targeted rewrites. We only recognize
 * statically provable write APIs and do not guess intent from the script text; the target is
 * recovered only from literals or literal variables.
 */
function inlineScriptMutation(command: string): InlineScriptMutation | null {
  const first = command.split('\n', 1)[0] ?? '';
  if (!/\b(?:python(?:3)?|node)\b[^\n]*<<-?\s*["']?[A-Za-z_][\w-]*/.test(first)) return null;
  const body = command.slice(command.indexOf('\n') + 1);
  const assignments = new Map<string, string>();
  const assignmentRe = /(?:^|\n)\s*(?:const\s+|let\s+|var\s+)?([A-Za-z_]\w*)\s*=\s*(["'])([^"'\n]+)\2/g;
  for (const match of body.matchAll(assignmentRe)) {
    const name = match[1]; const value = match[3];
    if (name && value) assignments.set(name, value);
  }
  const resolve = (raw: string | undefined): string | undefined => {
    const value = raw?.trim();
    if (!value) return undefined;
    const quoted = value.match(/^["']([^"']+)["']$/)?.[1];
    return quoted ?? assignments.get(value);
  };

  const deleteMatch = body.match(/(?:os\.(?:remove|unlink)|fs\.(?:unlinkSync|rmSync)|\.unlink)\s*\(\s*([^,)\n]+)/);
  if (deleteMatch) return { kind: 'delete', target: resolve(deleteMatch[1]) };

  const writeMatch = body.match(/open\s*\(\s*([^,\n]+),\s*["'][wa][^"']*["']/)
    ?? body.match(/(?:Path\s*\(\s*([^\n)]+)\s*\)\s*\.write_(?:text|bytes)|(?:fs\.)?(?:writeFileSync|appendFileSync)\s*\(\s*([^,\n]+))/);
  const writes = Boolean(writeMatch)
    || /\b(?:write_text|write_bytes|writeFileSync|appendFileSync)\s*\(/.test(body);
  if (!writes) return null;
  const target = resolve(writeMatch?.[1] ?? writeMatch?.[2]);
  const readsBeforeWrite = /(?:\.read\s*\(|read_text\s*\(|readFileSync\s*\(|\.replace\s*\()/.test(body);
  return { kind: readsBeforeWrite ? 'edit' : 'write', target };
}

function classifySimple(part: string): CommandAnalysis {
  const segment = simpleCommand(part);
  let kind = classifyToken(segment.token, segment.words, segment.headIndex);
  const args = segment.words.slice(segment.headIndex + 1);
  if (segment.token === 'curl' && args.some((arg) => arg === '-o' || arg === '--output')) kind = 'write';
  if (outputRedirectionTargets(part).length && kind !== 'delete' && kind !== 'edit') kind = 'write';
  return { kind, segment };
}

function analyzeGroup(group: string): CommandAnalysis {
  const pipeline = splitTopLevel(group, 'pipes').map(classifySimple);
  const first = pipeline[0] ?? { kind: 'noise' as const, segment: null };
  /*
   * Local sessions contain commands like `sed/awk ... | grep/rg ...` that "tidy the text stream
   * first, then search". When upstream is only stream production / preprocessing, the explicit
   * search stage is the action the user wants to see; but we only relax for these three read-only
   * tokens, and the whole pipeline must not contain write/edit/delete, so ordinary pipelines aren't
   * guessed as search.
   */
  const searchStage = pipeline.find((item, index) => index > 0 && item.kind === 'search');
  const firstToken = first.segment?.token ?? '';
  const hasMutation = pipeline.some((item) => item.kind === 'write' || item.kind === 'edit' || item.kind === 'delete');
  if (/^(cat|sed|awk)$/.test(firstToken) && searchStage && !hasMutation) return searchStage;
  if (first.kind !== 'exec' && first.kind !== 'noise') return first;
  // `grep | wc` is still search; but `env/curl | rg` has a semantics-free upstream, so look at the
  // first provable action downstream.
  return pipeline.find((item, index) => index > 0 && item.kind !== 'exec' && item.kind !== 'noise') ?? first;
}

function analyzeCommand(command: string): CommandAnalysis {
  const cmd = unwrapShell(command);
  const inline = inlineScriptMutation(cmd);
  if (inline) return { kind: inline.kind, segment: null, inlineTarget: inline.target };
  const groups = splitTopLevel(shellPrelude(cmd), 'groups').map(analyzeGroup);
  const use = groups.length ? groups : [{ kind: 'noise' as const, segment: null }];
  return use.reduce((winner, item) => (RANK[item.kind] > RANK[winner.kind] ? item : winner), use[0]!);
}

/**
 * Whether a shell command is reading, creating, editing, deleting, searching or just executing.
 *
 * Rules:
 *  · Only treat `>` / `>>` outside quotes as output redirection; fd control and search patterns
 *    don't count as writes
 *  · Sequence / logical connectors (`;` `&&` `||`) are only split at the shell top level, taking
 *    the highest-weight segment
 *  · A pipeline prefers upstream; only when upstream is semantics-free (`env/curl | rg`) do we look
 *    at the first provable action downstream
 *  · Python / Node heredocs only recognize static write APIs, without interpreting the script or
 *    guessing dynamic targets
 *  · A command that is entirely noise commands (`cd`, `echo`) → exec
 */
export function classifyCommand(command: string): ToolKind {
  const winner = analyzeCommand(command).kind;
  return winner === 'noise' ? 'exec' : winner;
}

/**
 * When the tool name itself is telling, accept it directly; `Bash` and the like need a look at the
 * command content.
 *
 * The list must be **conservative**: only classify when it can point to "what this call actually
 * did". Misclassifying is worse than classifying as `other` —— `other` only says "I can't tell",
 * whereas misclassifying is **misreporting** (drawing a network request as reading a file).
 * The unrecognized tier has an icon now too (see the fallback in `icons.tsx`), no longer degrading
 * to a dot.
 */
export function toolKind(toolName: string, input: unknown): ToolKind {
  const name = String(toolName ?? '').toLowerCase();
  if (WRITE_TOOLS.test(name)) return 'write';
  if (EDIT_TOOLS.test(name)) return 'edit';
  if (READ_TOOLS.test(name)) return 'read';
  if (SEARCH_TOOLS.test(name)) return 'search';
  if (isCommandTool(name)) return classifyCommand(commandOf(input));
  return 'other';
}

const WRITE_TOOLS = /^(write|write_file|create_file|new_file)$/;
const EDIT_TOOLS = /^(edit|multiedit|edit_file|apply_patch|str_replace|str_replace_editor|notebookedit|notebook_edit)$/;
/** "Fetching the content back" all counts as read: local files, remote pages — the same thing to
 * the user */
const READ_TOOLS = /^(read|read_file|view_file|webfetch|web_fetch|fetch|read_url|readmediafile)$/;
/**
 * "Going to find something" all counts as search: finding files, finding code, finding pages.
 *
 * **Meta tools (`ToolSearch` and the like) are not here** —— which kind they belong to is T4, and
 * the product hasn't decided yet.
 * For now they go to `other`, the row head gets the fallback icon, and we don't misreport them as
 * some kind.
 */
const SEARCH_TOOLS = /^(grep|glob|search|file_search|codebase_search|search_files|websearch|web_search)$/;

/**
 * Tools that run commands. PowerShell once slipped out of the list —— a whole turn of ten
 * PowerShell calls was judged "unknown", leaving only a dot at the row head, and the product
 * spotted it on the real page. The list recognizes by "it takes a command argument", not by
 * platform.
 */
export function isCommandTool(toolName: string): boolean {
  return /^(bash|sh|zsh|shell|powershell|pwsh|cmd|terminal|console|run_command|run_terminal_cmd|execute_command|local_shell|shell_command|terminal_command)$/
    .test(String(toolName ?? '').toLowerCase());
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

export function commandOf(input: unknown): string {
  const v = asRecord(input).command;
  return typeof v === 'string' ? v : '';
}

const basename = (p: string): string => String(p).replace(/^['"]|['"]$/g, '').split(/[\\/]/).pop() ?? '';

/** The file the tool input points straight at (Read / Write / Edit all have it) */
export function fileOf(input: unknown): { path: string; label: string } | null {
  const rec = asRecord(input);
  const p = rec.file_path ?? rec.filePath ?? rec.path;
  return typeof p === 'string' && p ? { path: p, label: basename(p) } : null;
}

function positionalArgs(args: readonly string[], optionsWithValue: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (options && arg === '--') { options = false; continue; }
    if (options && arg.startsWith('-') && arg !== '-') {
      if (optionsWithValue.has(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function safeSingleTarget(raw: string | undefined): string | null {
  const path = raw?.trim();
  if (!path || path === '-' || path === '/dev/null') return null;
  if (/[$*?\[\]{}<>|&;]/.test(path)) return null;
  return path;
}

function targetFromSimple(segment: SimpleCommand, kind: ClassifiedKind): string | null {
  const args = segment.words.slice(segment.headIndex + 1);
  const token = segment.token;
  if (kind === 'write') {
    const redirected = outputRedirectionTargets(segment.text).map(safeSingleTarget).filter((x): x is string => Boolean(x));
    if (redirected.length === 1) return redirected[0] ?? null;
    if (token === 'curl') {
      const index = args.findIndex((arg) => arg === '-o' || arg === '--output');
      return safeSingleTarget(index >= 0 ? args[index + 1] : undefined);
    }
    if (token === 'cp' || token === 'install') return safeSingleTarget(positionalArgs(args).at(-1));
    if (token === 'tee' || token === 'touch' || token === 'mkdir') {
      const targets = positionalArgs(args);
      return targets.length === 1 ? safeSingleTarget(targets[0]) : null;
    }
  }
  if (kind === 'edit') {
    if (token === 'sed') return safeSingleTarget(args.at(-1));
    if (token === 'perl') return safeSingleTarget(positionalArgs(args).at(-1));
    if (token === 'mv' || token === 'ln') return safeSingleTarget(positionalArgs(args).at(-1));
    if (token === 'chmod') {
      const targets = positionalArgs(args).slice(1);
      return targets.length === 1 ? safeSingleTarget(targets[0]) : null;
    }
    if (token === 'patch' || token === 'apply_patch') return safeSingleTarget(positionalArgs(args)[0]);
  }
  if (kind === 'delete') {
    const targets = positionalArgs(args);
    return targets.length === 1 ? safeSingleTarget(targets[0]) : null;
  }
  if (kind !== 'read') return null;

  if (token === 'sed') return safeSingleTarget(args.at(-1));
  if (token === 'awk' || token === 'jq') {
    const targets = positionalArgs(args).slice(1);
    return targets.length === 1 ? safeSingleTarget(targets[0]) : null;
  }
  const targets = positionalArgs(args, new Set(['-n', '--lines', '-c', '--bytes']));
  return targets.length === 1 ? safeSingleTarget(targets[0]) : null;
}

/**
 * Recover one statically provable file target from a shell command, so Bash can also be drawn as
 * "read / create / edit / delete + file name". Multi-target, glob and dynamic variables are not
 * guessed —— guessing wrong is worse than falling back to the command.
 */
export function commandFile(command: string): { path: string; label: string } | null {
  const analysis = analyzeCommand(command);
  const selectedIsPiped = analysis.segment != null && splitTopLevel(shellPrelude(unwrapShell(command)), 'groups')
    .some((group) => {
      const pipeline = splitTopLevel(group, 'pipes');
      return pipeline.length > 1 && pipeline.includes(analysis.segment?.text ?? '');
    });
  if (selectedIsPiped) return null;
  const raw = safeSingleTarget(analysis.inlineTarget)
    ?? (analysis.segment ? targetFromSimple(analysis.segment, analysis.kind) : null);
  return raw ? { path: raw, label: basename(raw) } : null;
}

/**
 * The search row should show "search <pattern> N hits" (D23), with the pattern extracted from the
 * input or the command.
 * Split words by quotes first, then cut at the first bare `|` / `&&` / `;` —— a `|` inside quotes
 * is part of the pattern.
 *
 * **Return `null` when it can't be extracted; don't fall back to the literal `'.'`.** This cell
 * answers "what was searched"; if the command doesn't say, there is no answer —— and `ToolRow`
 * stuffs this string into `FileButton`, so a fabricated `.` grows into a file that looks clickable
 * (on a real device that's "search . 14 hits" for the command
 * `cd "<project>" && ls -la && …`). The same rule has been written twice in this file: `commandFile`'s
 * "multi-target / glob / dynamic variables are not guessed —— guessing wrong is worse than falling
 * back to the command", and `ToolRow`'s fallback branch "must not fabricate a clickable file".
 *
 * The design spec only ever drew one search row, `search product-card 6 hits`, and no directory-listing row,
 * so no new row type is invented here —— after returning `null` the row reverts to the shapes the
 * spec already has (command but no natural-language summary → search + command + hit count;
 * has a summary → foldable command block). `pattern` has always been `string | null`, and `null`
 * has always been one of its values.
 */
export function searchPattern(_toolName: string, input: unknown): string | null {
  const rec = asRecord(input);
  const direct = rec.pattern ?? rec.query;
  if (typeof direct === 'string' && direct) return direct;
  const analysis = analyzeCommand(commandOf(input));
  const segment = analysis.kind === 'search' ? analysis.segment : null;
  if (!segment) return null;
  const head = segment.token;
  const toks = segment.words.slice(segment.headIndex + 1);
  // `docs` in `ls docs` is a target the user really typed, answer it as-is; `ls -la` has no
  // target, so there's no answer.
  if (/^(ls|tree)$/.test(head)) return positionalArgs(toks)[0] || null;
  if (/^(which|locate)$/.test(head)) return positionalArgs(toks)[0] ?? null;
  if (!/^(find|fd|grep|rg|egrep)$/.test(head)) return null;
  if (/^(find|fd)$/.test(head)) {
    // find only means "searched what" with -name/-iname/-path/-regex; `find . -type f` has no pattern
    for (let i = 0; i < toks.length - 1; i += 1) {
      const flag = toks[i]; const value = toks[i + 1];
      if (flag && value && /^-(i?name|i?path|regex)$/.test(flag)) return value;
    }
    const first = toks[0];
    return head === 'fd' && first && !first.startsWith('-') ? first : null;
  }
  for (let i = 0; i < toks.length; i += 1) {
    const tok = toks[i];
    if (!tok) continue;
    const next = toks[i + 1];
    if (/^(-e|--regexp)$/.test(tok) && next) return next;
    // `rg --files` merely lists files, so it has no pattern either; with `-g`, that glob is the pattern.
    if (tok === '--files') {
      const globIndex = toks.findIndex((value) => value === '-g' || value === '--glob');
      return globIndex >= 0 ? (toks[globIndex + 1] ?? null) : null;
    }
    if (/^(-g|--glob|-t|--type|-A|-B|-C|-m|--max-count|--include|--exclude|--exclude-dir)$/.test(tok)) {
      i += 1;
      continue;
    }
    if (tok.startsWith('-')) continue;
    return tok;
  }
  return null;
}

/**
 * Row title: use the natural-language summary when there is one (claude's `description`),
 * otherwise fall back to the command itself
 * —— codex has no description at all, in which case the design spec uses the single-line
 * "exec <command>" (S8).
 */
export function toolTitle(toolName: string, input: unknown): string {
  const rec = asRecord(input);
  if (typeof rec.description === 'string' && rec.description) return rec.description;
  const cmd = commandOf(input);
  if (cmd) return commandHeadline(unwrapShell(cmd));
  const pattern = rec.pattern ?? rec.query;
  if (typeof pattern === 'string' && pattern) return pattern;
  return String(toolName ?? '');
}

/**
 * Which slice to keep when a command is displayed as one line.
 *
 * Taking the first line is right —— but a **heredoc**'s first line happens to be the least
 * informative one: in `node - <<'NODE'` the script that's actually running is all on the following
 * lines, so all that's shown is "interpreter + delimiter"
 * (the user pointed this out on a real device: "there's nothing readable about this command").
 * So strip the heredoc opening marker along with the "read from stdin" `-` in front of it:
 *   `node - <<'NODE'`           → `node`
 *   `cat > page.html <<'EOF'`   → `cat > page.html` (what it's actually doing is kept)
 * If nothing is left after stripping (e.g. the whole line is `<<'X'`), fall back to the original,
 * better ugly than blank.
 */
export function commandHeadline(command: string): string {
  const first = String(command ?? '').split('\n')[0] ?? '';
  const stripped = first
    // heredoc opening marker: <<EOF / <<'EOF' / <<"EOF" / <<-EOF
    .replace(/\s*<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1\s*$/, '')
    // the lone "read from stdin" `-` immediately after it
    .replace(/\s+-\s*$/, '')
    .trim();
  return stripped || first.trim();
}

/** When the title is the raw command (rather than a natural-language summary), the UI must use a
 * monospace font */
export function isRawCommandTitle(toolName: string, input: unknown): boolean {
  return isCommandTool(toolName) && !asRecord(input).description;
}

/**
 * **Snapshot-style** tools: each call **replaces** the whole state rather than recording one ledger
 * entry.
 *
 * Every agent's version is called `TodoWrite` after daemon normalization; the match here is still
 * loosened to cover MCP-injected `mcp__*__todo_write` and codex's `update_plan`.
 *
 * Who uses it:
 *  · `build-turn-blocks` uses it to turn the snapshot into todo segments;
 *  · `dedupeToolUsesById` uses it to **let through multiple calls with the same id** —— some agents
 *    model "the plan" as a single item rewritten over and over, with five advances sharing one tool
 *    id, and deduping by id would drop every advance but the first (hit on a real device: after a
 *    full turn, all four todos were still "not started").
 */
/**
 * **Snapshot-style** tools: each call **replaces** the whole state rather than recording one ledger
 * entry.
 *
 * The criterion itself is **not here** —— it's the repo-wide single `isTodoWriteToolName` (in the
 * contract); this just gives it a name that explains "why the block builder and the deduper must
 * honor it".
 * This file once had its own `/i` regex while the contract's was an exact `===`, and the two
 * conventions diverged, so when AMR renamed it to `Todowrite` it showed up as "half broken": this
 * side recognized it, the other didn't.
 *
 * Who uses it:
 *  · `build-turn-blocks` uses it to turn the snapshot into todo segments;
 *  · `dedupeToolUsesById` uses it to **let through multiple calls with the same id** —— some agents
 *    model "the plan" as a single item rewritten over and over, with five advances sharing one tool
 *    id, and deduping by id would drop every advance but the first (hit on a real device: after a
 *    full turn, all four todos were still "not started").
 */
export function isSnapshotTool(toolName: string): boolean {
  return TODO_WRITE_TOOL_NAMES.has(String(toolName ?? ''));
}
