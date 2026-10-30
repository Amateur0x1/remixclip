/** @module agent-protocol/acp — unified entry point for the ACP protocol layer. */
export { attachAcpSession } from './session.js';
export type {
  AttachAcpSessionOptions,
  AcpSessionController,
} from './session.js';
export type { AcpMcpServerInput } from './session-params.js';

