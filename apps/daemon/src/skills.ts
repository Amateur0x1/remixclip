/**
 * [INPUT]: the shipped skill library (a markdown-only copy of the hyperframes skills) plus its manifest.
 * [OUTPUT]: a compact catalog section that tells the agent which skill to read, and where it is.
 * [POS]: daemon-side bridge between the bundled skill library and one turn's prompt; it never
 *        executes a skill itself — the agent decides when to read one.
 *
 * The catalog is deliberately small and static: it is prompt text that must stay stable so the
 * upstream prefix cache survives across turns. Skill bodies stay on disk and are read on demand.
 */
import { cpSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIDECAR_ENV } from '@remixclip/sidecar-proto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SkillEntry {
  id: string;
  summary: string;
  /** Absolute path of the skill's SKILL.md, as handed to the agent. */
  skillFile: string;
}

interface ManifestEntry {
  id?: unknown;
  summary?: unknown;
}

/**
 * Where the skill library lives, in priority order:
 * - `OD_SKILLS_DIR` — the launcher or the packaged desktop app names `resources/skills`;
 * - the repo layout, resolved from this file (apps/daemon/dist → repo root/skills).
 */
function resolveSkillsRoot(): string | null {
  const candidates = [
    process.env[SIDECAR_ENV.SKILLS_DIR],
    path.resolve(__dirname, '../../..', 'skills'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  return null;
}

let catalog: SkillEntry[] | null = null;

/**
 * Reads one manifest. Entries whose SKILL.md is missing are dropped instead of being advertised:
 * a broken prompt section is worse than a shorter catalog.
 */
function readCatalog(root: string): SkillEntry[] {
  const entries: SkillEntry[] = [];
  try {
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as {
      skills?: ManifestEntry[];
    };
    for (const item of manifest.skills ?? []) {
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
      if (!id || !summary) continue;
      const skillFile = path.join(root, id, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      entries.push({ id, summary, skillFile });
    }
  } catch {
    // A missing or malformed manifest must never block a turn: the turn just runs without skills.
  }
  return entries;
}

/** Catalog of the shipped library, read once per process. */
export function loadSkillCatalog(): SkillEntry[] {
  if (catalog) return catalog;
  const root = resolveSkillsRoot();
  catalog = root ? readCatalog(root) : [];
  return catalog;
}

/**
 * Copies the library into the project workspace on first use.
 *
 * The agent's sandbox is rooted at the project directory, so a library sitting in the app's
 * read-only resources may be unreadable for some runtimes. Materializing it once per project
 * (`<cwd>/.remixclip/skills`, next to the cut manifest) keeps every relative link inside the
 * skill files working and removes the dependency on cross-root read permissions.
 *
 * Returns the directory to advertise, or null when no library is bundled.
 */
export function materializeProjectSkills(cwd: string): string | null {
  const source = resolveSkillsRoot();
  if (!source) return null;
  const target = path.join(cwd, '.remixclip', 'skills');
  if (existsSync(path.join(target, 'manifest.json'))) return target;
  try {
    cpSync(source, target, { recursive: true, force: true });
    return existsSync(path.join(target, 'manifest.json')) ? target : null;
  } catch {
    // A read-only workspace still lets the agent read the original location.
    return source;
  }
}

/**
 * Prompt section listing the catalog. Returns '' when nothing is bundled, so the caller can drop
 * the section entirely (same convention as every other optional section in the run prompt).
 *
 * `skillsRoot` is the directory the paths should point at — the project-local copy when one was
 * materialized, otherwise the shipped library.
 */
export function buildSkillsPrompt(skillsRoot?: string | null): string {
  const skills = skillsRoot ? readCatalog(skillsRoot) : loadSkillCatalog();
  if (skills.length === 0) return '';
  return [
    '## 可参考的专业技能（按需读取）',
    '',
    '本机内置了一套动效视频制作技能库，可以当作复刻动作的参考手册。用法是**按需**：',
    '先判断这一步是否需要其中的具体方法（例如"这段转场怎么写""这个缓动用哪条规则"），',
    '需要时再用文件读取工具打开对应的 SKILL.md，按里面的规则执行；不需要就跳过，',
    '不要为了"用上技能"而套模板，也不要一次把多份技能全文读进上下文。',
    'SKILL.md 里提到的 `rules/`、`blueprints/`、`references/` 等同级文件，需要时按相对路径继续读。',
    '',
    skills.map((skill) => `- \`${skill.id}\`（${skill.summary}）— \`${skill.skillFile}\``).join('\n'),
  ].join('\n');
}

/** Test seam: drops the memoized catalog so a changed manifest can be re-read. */
export function resetSkillCatalog(): void {
  catalog = null;
}
