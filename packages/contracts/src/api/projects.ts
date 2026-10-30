/**
 * Project API types — the container that a chat belongs to (mirrors open-design's Project).
 *
 * A project owns:
 *   - a name and a private working directory (agents write their artifacts there),
 *   - a list of conversations (one conversation belongs to exactly one project, and a new
 *     project is created with its seed conversation so it is never born empty),
 *   - its own `customInstructions`, injected into every turn's prompt,
 *   - metadata describing what the project is for (kind / entry file / template).
 *
 * The selected local agent is NOT part of a project: it is a global preference
 * (`app-config.agentId`), exactly like open-design.
 */
import type { Conversation } from './chat.js';

/** What the project is meant to produce. `chat` is RemixClip's plain-chat default. */
export type ProjectKind =
  | 'chat'
  | 'prototype'
  | 'deck'
  | 'document'
  | 'image'
  | 'video'
  | 'other';

export interface ProjectMetadata {
  kind: ProjectKind;
  /** File the preview should open first (relative to the project working dir). */
  entryFile?: string;
  /** Template the project was created from (reserved; RemixClip ships none yet). */
  templateId?: string;
  templateLabel?: string;
}

export interface Project {
  id: string;
  name: string;
  /** Reserved, mirrors open-design. Always null in RemixClip today. */
  skillId: string | null;
  /** Reserved, mirrors open-design. Always null in RemixClip today. */
  designSystemId: string | null;
  /** Project-level instructions appended to every turn's prompt. */
  customInstructions: string | null;
  metadata: ProjectMetadata;
  createdAt: number;
  updatedAt: number;
  /** Number of conversations in this project (list responses only). */
  conversationCount?: number;
}

export interface ProjectsResponse {
  projects: Project[];
}

export interface CreateProjectRequest {
  name?: string;
  customInstructions?: string | null;
  metadata?: Partial<ProjectMetadata>;
  /** UI language tag: only used to title the seed conversation created with the project. */
  locale?: string;
}

/**
 * A new project always comes with its seed conversation — the project is never born empty,
 * so the client can land straight in a chat of the new project.
 */
export interface CreateProjectResponse {
  project: Project;
  conversation: Conversation;
}

export interface UpdateProjectRequest {
  name?: string;
  customInstructions?: string | null;
  metadata?: Partial<ProjectMetadata>;
}

/** The project every legacy conversation is migrated into on first launch. */
export const DEFAULT_PROJECT_NAME = '默认项目';
