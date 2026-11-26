import { DEVELOPER_LABELS, DEVELOPER_TOOLS } from './developer';
import { GOOGLE_LABELS, GOOGLE_TOOLS } from './google';
import { GOOGLE_MORE_LABELS, GOOGLE_MORE_TOOLS } from './googleMore';
import type { Tool } from './index';
import { MEDIA_LABELS, MEDIA_TOOLS } from './media';
import { MICROSOFT_LABELS, MICROSOFT_TOOLS } from './microsoft';
import type { ToolLabels } from './pluginUtil';
import { PRODUCTIVITY_LABELS, PRODUCTIVITY_TOOLS } from './productivity';

/** Every plugin's tools; the plugin catalog decides which are offered. */
export const PLUGIN_TOOLS: Tool[] = [
  ...GOOGLE_TOOLS,
  ...GOOGLE_MORE_TOOLS,
  ...MICROSOFT_TOOLS,
  ...DEVELOPER_TOOLS,
  ...PRODUCTIVITY_TOOLS,
  ...MEDIA_TOOLS,
];

/** One-line labels for plugin tool calls in the chat. */
export const PLUGIN_LABELS: ToolLabels = {
  ...GOOGLE_LABELS,
  ...GOOGLE_MORE_LABELS,
  ...MICROSOFT_LABELS,
  ...DEVELOPER_LABELS,
  ...PRODUCTIVITY_LABELS,
  ...MEDIA_LABELS,
};
