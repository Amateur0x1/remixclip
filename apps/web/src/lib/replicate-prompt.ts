/**
 * [INPUT]: One library item summary; the item's local source record when it has been downloaded.
 * [OUTPUT]: The first message of a recreation project, the library item it recreates, and the name
 *           the daemon gives the copy inside the project's `reference/` folder.
 * [POS]: Bridges the library's right-click menu and the chat composer; text lives in the i18n dict.
 *
 * The prompt never carries the library cache path. That path is a transient download slot; the
 * daemon copies the clip into `<projectDir>/reference/` before the first turn, so the agent is
 * pointed at a file that lives as long as the project does.
 */
import type { LibraryItemSummary } from '@remixclip/contracts';
import { t } from '@/i18n';
import { getLibraryShots, platformLabel } from '@/providers/library';

export interface ReplicateHandoff {
  prompt: string;
  /**
   * The dialog's "补充要求", carried as a run field instead of message text: the daemon injects it
   * into the prompt, so the chat transcript keeps showing only the brief the user actually sent.
   */
  guidance: string;
  libraryItemId: string;
  /**
   * Basename of the source clip under `<projectDir>/reference/`. Null when the item has no
   * downloaded source — the caller must ask the user to download it first instead of handing the
   * agent a post URL that expires (and is hotlink-protected anyway).
   */
  referenceName: string | null;
}

export interface RecreationHandoff {
  prompt: string;
  /** Same contract as {@link ReplicateHandoff.guidance}. */
  guidance: string;
  /** Every selected item, in selection order — becomes `metadata.sourceLibraryItemIds`. */
  itemIds: string[];
}

/** A source clip is required: a failed lookup means "not downloaded", never "guess the URL". */
async function resolveReferenceName(itemId: string): Promise<string | null> {
  try {
    const data = await getLibraryShots(itemId);
    if (data.media?.status !== 'ready') return null;
    return data.media.path.split('/').pop() ?? null;
  } catch {
    return null;
  }
}

export async function buildReplicateHandoff(
  item: LibraryItemSummary,
  /** Optional brief from the confirm dialog. Empty = recreate the whole clip as it is. */
  guidance = '',
): Promise<ReplicateHandoff> {
  const vars = {
    title: item.title || item.desc.slice(0, 80) || t('library.untitled'),
    platform: platformLabel(item.platform),
    author: item.author?.name ? `@${item.author.name}` : t('library.unknownAuthor'),
    url: item.pageUrl ?? '—',
    tags: item.tags.length ? item.tags.map((tag) => `#${tag}`).join(' ') : '—',
    desc: item.desc || '—',
  };
  const referenceName = await resolveReferenceName(item.id);
  const brief = referenceName
    ? t('library.replicatePromptLocal', { ...vars, path: `reference/${referenceName}` })
    : t('library.replicatePrompt', { ...vars, video: item.videoUrl ?? '—' });
  // Never appended to the brief: guidance is a separate run field, so the message the user sees
  // in the transcript stays byte-identical to the no-guidance path.
  const extra = guidance.trim();
  return { prompt: brief, guidance: extra, libraryItemId: item.id, referenceName };
}

/**
 * The first message of a multi-material recreation project.
 *
 * Every selected clip must already be local: the daemon copies them into `reference/` before the
 * first turn, and the brief names each copied file so the agent reads from disk instead of a post
 * URL. Callers therefore prepare downloads before asking for this handoff, not after.
 */
export async function buildRecreationHandoff(
  items: LibraryItemSummary[],
  guidance = '',
): Promise<RecreationHandoff> {
  const resolved = await Promise.all(items.map(async (item) => ({
    item,
    name: await resolveReferenceName(item.id),
  })));
  const missing = resolved.filter((entry) => !entry.name);
  if (missing.length) throw new Error(t('library.pickDownloadFailed', { count: missing.length }));

  const files = resolved
    .map(({ item, name }) => `- \`reference/${name}\`${item.title ? ` — ${item.title.slice(0, 60)}` : ''}`)
    .join('\n');
  const brief = t('library.replicateMultiPrompt', { count: resolved.length, files });
  const extra = guidance.trim();
  return {
    prompt: brief,
    guidance: extra,
    itemIds: resolved.map(({ item }) => item.id),
  };
}
