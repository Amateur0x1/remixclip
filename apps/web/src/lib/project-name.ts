/**
 * [INPUT]: A project row from `GET /api/projects` and the active translator.
 * [OUTPUT]: The project name to render — the seeded default project follows the UI language.
 * [POS]: One source for the name shown in the sidebar, the chat header and the rename box. The
 *        database keeps whatever the daemon seeded, so switching language needs no write and
 *        existing installs translate without a migration.
 */
import { DEFAULT_PROJECT_NAME, type Project } from '@remixclip/contracts';
import type { DictKey } from '@/i18n';

type Translate = (key: DictKey) => string;

export function projectDisplayName(
  project: Pick<Project, 'name'> | null | undefined,
  t: Translate,
): string {
  if (!project) return '';
  // The seed name predates any UI language and is not user content; a project the user renamed
  // stores its own string and is returned verbatim.
  if (project.name === DEFAULT_PROJECT_NAME) return t('workspace.defaultProject');
  return project.name;
}
