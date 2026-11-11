/**
 * [INPUT]: better-sqlite3 database connection and the conversation / project domain contract.
 * [OUTPUT]: SQLite setup (one schema snapshot, rebuilt on version mismatch), project &
 *           conversation & message persistence, upstream agent session-handle read/write.
 * [POS]: daemon's local database entry; creates tables from the schema snapshot at startup.
 * [PROTOCOL]: Not released yet, so there are NO incremental migrations. To change the schema,
 *            edit SCHEMA_SQL directly and bump SCHEMA_VERSION; any version mismatch rebuilds the
 *            whole file. Local projects/media are re-importable, so rebuilding is the cheap and
 *            correct answer compared with carrying migration debt for a schema still in motion.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, Conversation, Project, ProjectCut, ProjectKind, ProjectMetadata } from '@remixclip/contracts';
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
 * Schema snapshot version: bump by 1 when SCHEMA_SQL changes. Not released yet, so there is no
 * migration path — a mismatch rebuilds the file from this snapshot.
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

  -- A conversation lives inside exactly ONE project, and a project has exactly ONE
  -- conversation: the chat IS the project. project_id is NOT NULL and UNIQUE (see
  -- idx_conversations_project_unique), and deleting the project deletes its conversation.
  -- Conversations are never moved between projects.
  --
  -- No session handle lives here: one conversation can be driven by several agents, and each
  -- agent owns its own upstream session (see agent_sessions). A single handle column would make
  -- switching agents destructive — the second agent overwrites the first one's handle.
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- 1:1 is a database guarantee, not a convention the routes must remember: a second
  -- conversation for the same project is rejected at INSERT time.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_project_unique
    ON conversations(project_id);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    -- Author of an assistant message (NULL for user/system messages). History replay is scoped
    -- by this column: agent B must not inherit agent A's reasoning as if it were its own.
    agent_id TEXT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    run_id TEXT,
    artifacts TEXT,
    attachments TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, created_at);

  -- The turn's tool process (operation chips + capped outputs). A side table rather than a
  -- column: it is bulky, optional, and only assistant messages carry it.
  CREATE TABLE IF NOT EXISTS message_process (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    payload TEXT NOT NULL
  );

  -- Upstream agent session, one row per (conversation, agent). This is a CACHE, not the history:
  -- the conversation in the messages table stays the source of truth, a lost handle only costs
  -- one replay.
  --
  -- last_message_id is the cursor proving the handle is still current: if it no longer matches
  -- the conversation's latest completed assistant message, somebody else ran in between (another
  -- agent, a deleted message, an edited turn) and the handle must not be reused.
  CREATE TABLE IF NOT EXISTS agent_sessions (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    model TEXT,
    cwd TEXT,
    last_message_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, agent_id)
  );

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

  -- 成片库: one finished cut per project. project_id is the primary key, so "a project has at most
  -- one cut" is enforced at INSERT time; ON DELETE CASCADE removes the row with its project.
  -- output_path is always output/final.mp4 today, but stays a column so the contract can grow.
  CREATE TABLE IF NOT EXISTS project_cuts (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,
    run_id TEXT,
    output_path TEXT NOT NULL,
    reference_path TEXT,
    poster_path TEXT,
    size INTEGER NOT NULL,
    duration_ms INTEGER,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_project_cuts_updated
    ON project_cuts(updated_at DESC);
`;

function ensureSchema(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  if (currentVersion !== SCHEMA_VERSION) {
    // Not released yet: the schema is one snapshot and carries no migration debt. Any mismatch
    // (an older build, or a file written by a newer one) means this file is not this build's
    // shape, so rebuild it rather than guess at a half-old, half-new schema.
    dropAllTables(db);
  }
  db.exec(SCHEMA_SQL);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function dropAllTables(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS project_cuts;
    DROP TABLE IF EXISTS agent_sessions;
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

// ── Finished cuts (成片库) ────────────────────────────────────────────────

interface ProjectCutRow {
  project_id: string;
  project_name: string;
  conversation_id: string;
  run_id: string | null;
  output_path: string;
  reference_path: string | null;
  poster_path: string | null;
  size: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  created_at: number;
  updated_at: number;
}

function rowToProjectCut(row: ProjectCutRow): ProjectCut {
  return {
    projectId: row.project_id,
    projectName: row.project_name,
    conversationId: row.conversation_id,
    outputPath: row.output_path,
    referencePath: row.reference_path,
    posterPath: row.poster_path,
    size: row.size,
    durationMs: row.duration_ms,
    width: row.width,
    height: row.height,
    runId: row.run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CUT_SELECT = `SELECT c.*, p.name AS project_name
  FROM project_cuts c JOIN projects p ON p.id = c.project_id`;

/** The project's one finished cut, or null — projects may legitimately have none. */
export function getProjectCut(db: Database.Database, projectId: string): ProjectCut | null {
  const row = db.prepare(`${CUT_SELECT} WHERE c.project_id = ?`).get(projectId) as ProjectCutRow | undefined;
  return row ? rowToProjectCut(row) : null;
}

/** Every cut, newest first: the 成片库 grid reads this. */
export function listProjectCuts(db: Database.Database): ProjectCut[] {
  const rows = db.prepare(`${CUT_SELECT} ORDER BY c.updated_at DESC`).all() as ProjectCutRow[];
  return rows.map(rowToProjectCut);
}

/**
 * Record (or refresh) the project's single cut. The upsert is the 1:1 rule in action: a newer
 * render overwrites the row instead of appending a second cut, while created_at keeps the first.
 */
export function upsertProjectCut(
  db: Database.Database,
  input: Omit<ProjectCut, 'projectName' | 'createdAt' | 'updatedAt'> & { updatedAt?: number },
): ProjectCut {
  const now = input.updatedAt ?? Date.now();
  db.prepare(
    `INSERT INTO project_cuts
       (project_id, conversation_id, run_id, output_path, reference_path, poster_path,
        size, duration_ms, width, height, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       conversation_id = excluded.conversation_id,
       run_id = excluded.run_id,
       output_path = excluded.output_path,
       reference_path = excluded.reference_path,
       poster_path = excluded.poster_path,
       size = excluded.size,
       duration_ms = excluded.duration_ms,
       width = excluded.width,
       height = excluded.height,
       updated_at = excluded.updated_at`,
  ).run(
    input.projectId,
    input.conversationId,
    input.runId,
    input.outputPath,
    input.referencePath,
    input.posterPath,
    input.size,
    input.durationMs,
    input.width,
    input.height,
    now,
    now,
  );
  return getProjectCut(db, input.projectId) as ProjectCut;
}

/** The cut disappeared from disk (or the user removed it): drop the index row, keep the project. */
export function deleteProjectCut(db: Database.Database, projectId: string): void {
  db.prepare(`DELETE FROM project_cuts WHERE project_id = ?`).run(projectId);
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

/** Ensure the default project exists (used on first launch). */
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
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  agent_id: string | null;
  content: string;
  created_at: number;
  run_id: string | null;
  artifacts: string | null;
  attachments: string | null;
  process_payload?: string | null;
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
  let process: ChatMessage['process'];
  if (row.process_payload) {
    try {
      process = JSON.parse(row.process_payload) as ChatMessage['process'];
    } catch {
      process = undefined;
    }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as ChatMessage['role'],
    agentId: row.agent_id ?? undefined,
    content: row.content,
    createdAt: row.created_at,
    runId: row.run_id ?? undefined,
    artifacts,
    attachments,
    process,
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

/** The project's single conversation (1:1), if it exists yet. */
export function getProjectConversation(
  db: Database.Database,
  projectId: string,
): Conversation | null {
  const row = db
    .prepare(
      `SELECT c.*, COUNT(m.id) AS message_count
       FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE c.project_id = ?
       GROUP BY c.id`,
    )
    .get(projectId) as (ConversationRow & { message_count: number }) | undefined;
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    projectId: row.project_id,
  };
}

/**
 * Get-or-create the project's conversation. In a 1:1 model "create a chat" is really "open the
 * chat", so asking twice must never produce a second one — the same rule the
 * idx_conversations_project_unique index enforces underneath.
 */
export function ensureProjectConversation(
  db: Database.Database,
  projectId: string,
  title: string,
): Conversation {
  const existing = getProjectConversation(db, projectId);
  if (existing) return existing;
  try {
    return createConversation(db, projectId, title);
  } catch (error) {
    // Two writers raced (e.g. a run and the POST at the same moment): the unique index rejected
    // the loser, and the winner's row is the project's chat. Return it instead of failing.
    const winner = getProjectConversation(db, projectId);
    if (winner) return winner;
    throw error;
  }
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

// ── Upstream agent sessions (resume cache) ─────────────────────────────

export interface AgentSessionRecord {
  /** Runtime agent id that owns the handle (claude / codex / ...). */
  agentId: string;
  /** Agent-side durable session handle (claude session_id / ACP sessionId). */
  sessionId: string;
  /** Model the handle was created under (null = the CLI's own default). */
  model: string | null;
  /** Normalized working directory at creation time. */
  cwd: string | null;
  /** Cursor: the latest completed assistant message at the time the handle was written. */
  lastMessageId: string | null;
  updatedAt: number;
}

interface AgentSessionRow {
  agent_id: string;
  session_id: string;
  model: string | null;
  cwd: string | null;
  last_message_id: string | null;
  updated_at: number;
}

/**
 * The handle for one (conversation, agent) pair. Returns null when this agent never ran here —
 * which is exactly what "the user switched agents" looks like: no write happened, just a miss.
 */
export function getAgentSession(
  db: Database.Database,
  conversationId: string,
  agentId: string,
): AgentSessionRecord | null {
  const row = db
    .prepare(
      `SELECT agent_id, session_id, model, cwd, last_message_id, updated_at
       FROM agent_sessions WHERE conversation_id = ? AND agent_id = ?`,
    )
    .get(conversationId, agentId) as AgentSessionRow | undefined;
  if (!row) return null;
  return {
    agentId: row.agent_id,
    sessionId: row.session_id,
    model: row.model,
    cwd: row.cwd,
    lastMessageId: row.last_message_id,
    updatedAt: row.updated_at,
  };
}

/** Write/replace this agent's handle. Never touches another agent's row. */
export function upsertAgentSession(
  db: Database.Database,
  input: {
    conversationId: string;
    agentId: string;
    sessionId: string;
    model?: string | null;
    cwd?: string | null;
    lastMessageId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO agent_sessions
       (conversation_id, agent_id, session_id, model, cwd, last_message_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id, agent_id) DO UPDATE SET
       session_id = excluded.session_id,
       model = excluded.model,
       cwd = excluded.cwd,
       last_message_id = excluded.last_message_id,
       updated_at = excluded.updated_at`,
  ).run(
    input.conversationId,
    input.agentId,
    input.sessionId,
    input.model ?? null,
    input.cwd ?? null,
    input.lastMessageId ?? null,
    Date.now(),
  );
}

/** Drop a dead handle (resume failed, or the upstream session no longer exists). */
export function clearAgentSession(
  db: Database.Database,
  conversationId: string,
  agentId: string,
): void {
  db.prepare(`DELETE FROM agent_sessions WHERE conversation_id = ? AND agent_id = ?`).run(
    conversationId,
    agentId,
  );
}

/**
 * The conversation's latest completed assistant message — the cursor every handle is validated
 * against. `rowid` breaks the created_at tie: two messages written in the same millisecond must
 * still have a stable order, otherwise a resumed handle could point at the wrong turn.
 */
export function latestAssistantMessageId(
  db: Database.Database,
  conversationId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT id FROM messages
       WHERE conversation_id = ? AND role = 'assistant'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(conversationId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function deleteConversation(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
}

export function listMessages(db: Database.Database, conversationId: string): ChatMessage[] {
  const rows = db
    .prepare(
      `SELECT m.*, p.payload AS process_payload
       FROM messages m
       LEFT JOIN message_process p ON p.message_id = m.id
       WHERE m.conversation_id = ?
       ORDER BY m.created_at ASC`,
    )
    .all(conversationId) as MessageRow[];
  return rows.map(rowToMessage);
}

export function appendMessage(
  db: Database.Database,
  input: {
    conversationId: string;
    role: ChatMessage['role'];
    /** Author agent id for assistant messages (history scoping reads it back). */
    agentId?: string;
    content: string;
    runId?: string;
    artifacts?: ChatMessage['artifacts'];
    attachments?: ChatMessage['attachments'];
    /** The turn's tool/thinking timeline; stored beside the message so reloads keep the chips. */
    process?: ChatMessage['process'];
  },
): ChatMessage {
  const id = `msg_${randomUUID()}`;
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, agent_id, content, created_at, run_id, artifacts, attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.conversationId,
    input.role,
    input.agentId ?? null,
    input.content,
    createdAt,
    input.runId ?? null,
    input.artifacts?.length ? JSON.stringify(input.artifacts) : null,
    input.attachments?.length ? JSON.stringify(input.attachments) : null,
  );
  if (input.process && (input.process.toolCalls.length > 0 || input.process.items.length > 0)) {
    db.prepare(
      `INSERT OR REPLACE INTO message_process (message_id, payload) VALUES (?, ?)`,
    ).run(id, JSON.stringify(input.process));
  }
  touchConversation(db, input.conversationId);
  return {
    id,
    conversationId: input.conversationId,
    role: input.role,
    agentId: input.agentId,
    content: input.content,
    createdAt,
    runId: input.runId,
    artifacts: input.artifacts,
    attachments: input.attachments,
  };
}
