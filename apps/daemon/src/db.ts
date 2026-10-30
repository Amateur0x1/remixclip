/**
 * [INPUT]: better-sqlite3 database connection and the conversation / project domain contract.
 * [OUTPUT]: SQLite setup (schema snapshot + additive migrations), project & conversation &
 *           message persistence, upstream agent session-handle read/write.
 * [POS]: daemon's local database entry; creates tables from the schema snapshot at startup.
 * [PROTOCOL]: Project is not released yet, so no incremental migrations are maintained: to
 *            change the schema, edit SCHEMA_SQL directly and bump SCHEMA_VERSION; on a version
 *            mismatch the whole database is rebuilt (local data can be re-imported / re-downloaded).
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, Conversation, Project, ProjectKind, ProjectMetadata } from '@remixclip/contracts';
import { DEFAULT_PROJECT_NAME } from '@remixclip/contracts';

export interface RemixclipDb {
  db: Database.Database;
  close: () => void;
}

export function openDatabase(dbPath: string): RemixclipDb {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    ensureSchema(db);
    return { db, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Schema snapshot version: bump by 1 when SCHEMA_SQL changes; before release, rebuild
 * rather than take on migration debt.
 */
const SCHEMA_VERSION = 1;

/** The one project that always exists on a fresh install: the sidebar is never empty. */
export const DEFAULT_PROJECT_ID = 'proj_default';

/** Single definition of all business tables: to add a field, edit here — no ALTER, no
 *  appended migrations. */
const SCHEMA_SQL = `
  -- A project is the container a conversation belongs to: name + instructions + metadata.
  -- The working directory lives on disk under <dataDir>/projects/<projectId>.
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    skill_id TEXT,
    design_system_id TEXT,
    custom_instructions TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- A conversation lives inside exactly ONE project: project_id is NOT NULL, and deleting
  -- the project deletes its conversations. Conversations are never moved between projects.
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    durable_session_id TEXT,
    session_agent_id TEXT,
    session_cwd TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_project
    ON conversations(project_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    run_id TEXT,
    artifacts TEXT,
    attachments TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, created_at);

  -- Social-media library: items and batches imported by the extension (comment bodies are
  -- stored together with the payload).
  CREATE TABLE IF NOT EXISTS library_items (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    kind TEXT NOT NULL,
    remote_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    author_name TEXT,
    cover_url TEXT,
    tags TEXT NOT NULL DEFAULT '',
    published_at INTEGER,
    imported_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    batch_id TEXT,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_library_items_imported
    ON library_items(imported_at DESC);
  CREATE INDEX IF NOT EXISTS idx_library_items_platform
    ON library_items(platform, imported_at DESC);

  CREATE TABLE IF NOT EXISTS library_batches (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    source TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    label TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_library_batches_created
    ON library_batches(created_at DESC);

  -- On-disk videos: local video files for an item (source download / render output) plus
  -- download progress.
  CREATE TABLE IF NOT EXISTS media_files (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    bytes INTEGER,
    duration_ms INTEGER,
    width INTEGER,
    height INTEGER,
    fps REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    progress REAL NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_media_files_item
    ON media_files(item_id, kind);
  CREATE INDEX IF NOT EXISTS idx_media_files_status
    ON media_files(status);

  -- Shot breakdown: time-sliced shot ranges and extracted thumbnail frames per item.
  CREATE TABLE IF NOT EXISTS shots (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    thumbnail_path TEXT,
    analysis_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_shots_item
    ON shots(item_id, "index");

  -- Pixel check: total score, verdict and per-shot / per-sample-point report of a render comparison.
  CREATE TABLE IF NOT EXISTS comparisons (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    render_media_id TEXT,
    total_score REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    report_json TEXT NOT NULL DEFAULT '{"shots":[],"sourceShotCount":0,"renderShotCount":0}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_comparisons_item
    ON comparisons(item_id, created_at DESC);
`;

function ensureSchema(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  if (currentVersion !== SCHEMA_VERSION) {
    // Not released yet: no historical data to preserve, so rebuild on version mismatch to avoid
    // a half-old, half-new schema.
    db.exec(`
      DROP TABLE IF EXISTS comparisons;
      DROP TABLE IF EXISTS shots;
      DROP TABLE IF EXISTS media_files;
      DROP TABLE IF EXISTS library_batches;
      DROP TABLE IF EXISTS library_items;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS conversations;
      DROP TABLE IF EXISTS projects;
    `);
  }
  db.exec(SCHEMA_SQL);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export function getDefaultDbPath(dataDir: string): string {
  return path.join(dataDir, 'remixclip.db');
}

// ── Project store ──────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  skill_id: string | null;
  design_system_id: string | null;
  custom_instructions: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  conversation_count?: number;
}

const DEFAULT_PROJECT_METADATA: ProjectMetadata = { kind: 'chat' };

function parseProjectMetadata(raw: string | null): ProjectMetadata {
  if (!raw) return { ...DEFAULT_PROJECT_METADATA };
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectMetadata>;
    return {
      ...DEFAULT_PROJECT_METADATA,
      ...parsed,
      kind: (parsed.kind as ProjectKind | undefined) ?? DEFAULT_PROJECT_METADATA.kind,
    };
  } catch {
    return { ...DEFAULT_PROJECT_METADATA };
  }
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    skillId: row.skill_id,
    designSystemId: row.design_system_id,
    customInstructions: row.custom_instructions,
    metadata: parseProjectMetadata(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.conversation_count != null ? { conversationCount: row.conversation_count } : {}),
  };
}

/** All projects, newest activity first, with their conversation counts. */
export function listProjects(db: Database.Database): Project[] {
  const rows = db
    .prepare(
      `SELECT p.*, (
         SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id
       ) AS conversation_count
       FROM projects p
       ORDER BY p.updated_at DESC`,
    )
    .all() as ProjectRow[];
  return rows.map(rowToProject);
}

export function getProject(db: Database.Database, id: string): Project | null {
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

export function createProject(
  db: Database.Database,
  input: { name?: string; customInstructions?: string | null; metadata?: Partial<ProjectMetadata>; id?: string },
): Project {
  const now = Date.now();
  const id = input.id ?? `proj_${randomUUID()}`;
  const name = input.name?.trim() || DEFAULT_PROJECT_NAME;
  const metadata: ProjectMetadata = { ...DEFAULT_PROJECT_METADATA, ...input.metadata };
  db.prepare(
    `INSERT INTO projects (id, name, skill_id, design_system_id, custom_instructions, metadata_json, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)`,
  ).run(id, name, input.customInstructions ?? null, JSON.stringify(metadata), now, now);
  return {
    id,
    name,
    skillId: null,
    designSystemId: null,
    customInstructions: input.customInstructions ?? null,
    metadata,
    createdAt: now,
    updatedAt: now,
    conversationCount: 0,
  };
}

/**
 * Create a project together with its seed conversation — a project is never born empty, so
 * the first thing the user sees is a chat in the new project (same as open-design).
 */
export function createProjectWithConversation(
  db: Database.Database,
  input: {
    name?: string;
    customInstructions?: string | null;
    metadata?: Partial<ProjectMetadata>;
    conversationTitle: string;
  },
): { project: Project; conversation: Conversation } {
  return db.transaction(() => {
    const project = createProject(db, input);
    const conversation = createConversation(db, project.id, input.conversationTitle);
    return { project: { ...project, conversationCount: 1 }, conversation };
  })();
}

/** Ids of every conversation inside a project (used to cancel the project's runs on delete). */
export function listConversationIds(db: Database.Database, projectId: string): string[] {
  const rows = db.prepare(`SELECT id FROM conversations WHERE project_id = ?`).all(projectId) as { id: string }[];
  return rows.map((row) => row.id);
}

/** Ensure the default project exists (used on first launch and by the v1→v2 migration). */
export function ensureDefaultProject(db: Database.Database): Project {
  const existing = getProject(db, DEFAULT_PROJECT_ID);
  if (existing) return existing;
  const any = db.prepare(`SELECT * FROM projects ORDER BY created_at ASC LIMIT 1`).get() as ProjectRow | undefined;
  if (any) return rowToProject(any);
  return createProject(db, { id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME });
}

export function updateProject(
  db: Database.Database,
  id: string,
  patch: { name?: string; customInstructions?: string | null; metadata?: Partial<ProjectMetadata> },
): Project | null {
  const current = getProject(db, id);
  if (!current) return null;
  const next: Project = {
    ...current,
    name: patch.name?.trim() || current.name,
    customInstructions: patch.customInstructions === undefined ? current.customInstructions : patch.customInstructions,
    metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
    updatedAt: Date.now(),
  };
  db.prepare(
    `UPDATE projects SET name = ?, custom_instructions = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
  ).run(next.name, next.customInstructions, JSON.stringify(next.metadata), next.updatedAt, id);
  return next;
}

/** Delete a project and (via ON DELETE CASCADE) every conversation inside it. */
export function deleteProject(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
}

/** Bump a project's activity timestamp when something inside it changes. */
export function touchProject(db: Database.Database, id: string): void {
  db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run(Date.now(), id);
}

// ── Conversation store ─────────────────────────────────────────────────────

interface ConversationRow {
  id: string;
  project_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  durable_session_id: string | null;
  session_agent_id: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: number;
  run_id: string | null;
  artifacts: string | null;
  attachments: string | null;
}

function rowToMessage(row: MessageRow): ChatMessage {
  let artifacts: ChatMessage['artifacts'];
  if (row.artifacts) {
    try {
      artifacts = JSON.parse(row.artifacts) as ChatMessage['artifacts'];
    } catch {
      artifacts = undefined;
    }
  }
  let attachments: ChatMessage['attachments'];
  if (row.attachments) {
    try {
      attachments = JSON.parse(row.attachments) as ChatMessage['attachments'];
    } catch {
      attachments = undefined;
    }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as ChatMessage['role'],
    content: row.content,
    createdAt: row.created_at,
    runId: row.run_id ?? undefined,
    artifacts,
    attachments,
  };
}

export function listConversations(db: Database.Database, projectId?: string): Conversation[] {
  const rows = db
    .prepare(
      `SELECT c.*, COUNT(m.id) AS message_count
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE (? IS NULL OR c.project_id = ?)
       GROUP BY c.id
       ORDER BY c.updated_at DESC`,
    )
    .all(projectId ?? null, projectId ?? null) as (ConversationRow & { message_count: number })[];
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    projectId: row.project_id,
  }));
}

export function createConversation(
  db: Database.Database,
  projectId: string,
  title: string,
): Conversation {
  const now = Date.now();
  const id = `conv_${randomUUID()}`;
  db.prepare(
    `INSERT INTO conversations (id, project_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, projectId, title, now, now);
  touchProject(db, projectId);
  return { id, title, createdAt: now, updatedAt: now, messageCount: 0, projectId };
}

/** The project a conversation is filed under (null when the conversation is gone). */
export function getConversationProjectId(db: Database.Database, id: string): string | null {
  const row = db.prepare(`SELECT project_id FROM conversations WHERE id = ?`).get(id) as
    | { project_id: string }
    | undefined;
  return row ? row.project_id : null;
}

export function touchConversation(db: Database.Database, id: string): void {
  const now = Date.now();
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now, id);
  // A conversation bump is also activity for its project (keeps the project list ordered).
  db.prepare(
    `UPDATE projects SET updated_at = ? WHERE id = (SELECT project_id FROM conversations WHERE id = ?)`,
  ).run(now, id);
}

// ── Durable session handle (session resume) ─────────────────────────────

export interface ConversationSession {
  /** Runtime agent id that owns the handle (claude/hermes/...). */
  agentId: string;
  /** Agent-side durable session handle (claude session_id / ACP sessionId). */
  sessionId: string;
  /** Normalized working directory for the handle; an unknown legacy dir can't resume
   *  across directories. */
  cwd: string | null;
}

/** Read the session's current upstream session handle (null if none). */
export function getConversationSession(
  db: Database.Database,
  id: string,
): ConversationSession | null {
  const row = db
    .prepare(
      `SELECT session_agent_id, durable_session_id, session_cwd
       FROM conversations WHERE id = ?`,
    )
    .get(id) as { session_agent_id: string | null; durable_session_id: string | null; session_cwd: string | null } | undefined;
  if (!row?.durable_session_id) return null;
  return { agentId: row.session_agent_id ?? '', sessionId: row.durable_session_id, cwd: row.session_cwd };
}

/** Write/update the session's upstream session handle (called at run end when a handle
 *  was captured). */
export function setConversationSession(
  db: Database.Database,
  id: string,
  agentId: string,
  sessionId: string,
  cwd: string | null = null,
): void {
  db.prepare(
    `UPDATE conversations
     SET session_agent_id = ?, durable_session_id = ?, session_cwd = ?
     WHERE id = ?`,
  ).run(agentId, sessionId, cwd, id);
}

/** Clear the session's upstream session handle (forces a new session next turn). */
export function clearConversationSession(db: Database.Database, id: string): void {
  db.prepare(
    `UPDATE conversations SET session_agent_id = NULL, durable_session_id = NULL, session_cwd = NULL WHERE id = ?`,
  ).run(id);
}

export function deleteConversation(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
}

export function listMessages(db: Database.Database, conversationId: string): ChatMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`,
    )
    .all(conversationId) as MessageRow[];
  return rows.map(rowToMessage);
}

export function appendMessage(
  db: Database.Database,
  input: {
    conversationId: string;
    role: ChatMessage['role'];
    content: string;
    runId?: string;
    artifacts?: ChatMessage['artifacts'];
    attachments?: ChatMessage['attachments'];
  },
): ChatMessage {
  const id = `msg_${randomUUID()}`;
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, created_at, run_id, artifacts, attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.conversationId,
    input.role,
    input.content,
    createdAt,
    input.runId ?? null,
    input.artifacts?.length ? JSON.stringify(input.artifacts) : null,
    input.attachments?.length ? JSON.stringify(input.attachments) : null,
  );
  touchConversation(db, input.conversationId);
  return {
    id,
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    createdAt,
    runId: input.runId,
    artifacts: input.artifacts,
    attachments: input.attachments,
  };
}
