/** @module agent-protocol/acp/models
 * Session model parsing ported from open-design acp/models.ts —
 * identifying the model config option in configOptions, reading the current model, and deciding
 * whether a model selection error is recoverable.
 */

import { asObject, type JsonObject } from './json.js';

/** Normalized ids in configOptions that mark a “model selection” option. */
export const MODEL_CONFIG_OPTION_IDS = new Set(['model', 'models', 'modelid', 'modelids']);

export interface AcpModelConfigOption {
  configId: string;
  currentValue: string | null;
  values: unknown[];
}

function isModelConfigOption(option: JsonObject, configId: string): boolean {
  const normalized = configId.toLowerCase();
  if (MODEL_CONFIG_OPTION_IDS.has(normalized)) return true;
  const category = typeof option.category === 'string' ? option.category.toLowerCase() : '';
  return category === 'model';
}

/** Find the model config option in the configOptions of a session/new response; null if absent. */
export function findModelConfigOption(configOptions: unknown): AcpModelConfigOption | null {
  const options = Array.isArray(configOptions) ? configOptions : [];
  for (const rawOption of options) {
    const option = asObject(rawOption);
    if (!option) continue;
    const configId = typeof option.id === 'string' ? option.id.trim() : '';
    if (!configId) continue;
    const type = typeof option.type === 'string' ? option.type.trim() : '';
    if (type && type !== 'select') continue;
    if (!isModelConfigOption(option, configId)) continue;
    const currentValue =
      typeof option.currentValue === 'string' && option.currentValue.trim()
        ? option.currentValue.trim()
        : null;
    return {
      configId,
      currentValue,
      values: Array.isArray(option.options) ? option.options : [],
    };
  }
  return null;
}

/**
 * JSON-RPC error codes after which a failed model selection is recoverable (fall back to the default
 * model and keep sending the prompt).
 */
export function modelSelectionErrorIsRecoverable(code: unknown): boolean {
  return code === -32603 || code === -32602 || code === -32601 || code === -32002;
}

/**
 * Read the current model id from a session/new (or set_model) response:
 * configOptions first, falling back to models.currentModelId.
 */
export function currentModelFromSessionResult(result: JsonObject): string | null {
  const configCurrent = findModelConfigOption(result.configOptions)?.currentValue;
  if (configCurrent) return configCurrent;
  const models = asObject(result.models);
  return typeof models?.currentModelId === 'string' && models.currentModelId.trim()
    ? models.currentModelId.trim()
    : null;
}
