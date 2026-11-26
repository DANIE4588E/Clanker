import { usePlugins, type McpToolInfo } from '@/store/plugins';
import { importAsset } from '../attachments';
import { PLUGINS } from '../plugins/catalog';
import { callMcpTool, mcpConfig, type McpContent } from '../plugins/mcp';
import type { ProviderId } from '../plugins/providers';
import type { ImagePart } from '../providers';
import type { Tool, ToolOutcome } from './index';
import { clip, extOf, fromBase64, safeName, saveDownload } from './pluginUtil';

/**
 * The tools of connected MCP servers, as the agent's own tools: named <prefix>_<tool>, with their
 * input schemas narrowed to what every model provider accepts, and results turned into text,
 * images and workspace files.
 */

const MAX_DESCRIPTION = 1500;
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
};

type Schema = Record<string, any>;

/**
 * A JSON Schema reduced to the common subset of OpenAI, Anthropic and Gemini function parameters:
 * $refs inlined, anyOf/oneOf/allOf and type arrays collapsed to one type (the alternatives noted
 * in the description), and keywords some providers reject dropped.
 */
export function simplifySchema(schema: unknown, root: Schema = (schema as Schema) ?? {}, depth = 0): Schema {
  if (!schema || typeof schema !== 'object' || depth > 12) return {};
  let s = schema as Schema;

  if (typeof s.$ref === 'string') {
    const target = s.$ref
      .replace(/^#\//, '')
      .split('/')
      .reduce<any>((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    s = { ...target, ...(s.description ? { description: s.description } : {}) };
  }

  let note = '';
  if (Array.isArray(s.allOf)) {
    const merged = s.allOf.map((x: unknown) => simplifySchema(x, root, depth + 1));
    s = {
      ...Object.assign({}, ...merged),
      properties: Object.assign({}, ...merged.map((m: Schema) => m.properties ?? {})),
      required: merged.flatMap((m: Schema) => m.required ?? []),
      ...(s.description ? { description: s.description } : {}),
    };
  }
  const alternatives = s.anyOf ?? s.oneOf;
  if (Array.isArray(alternatives)) {
    const options = alternatives.map((x: unknown) => simplifySchema(x, root, depth + 1)).filter((x: Schema) => x.type !== 'null');
    const pick = options.find((o: Schema) => o.type === 'object') ?? options[0] ?? {};
    const types = [...new Set(options.map((o: Schema) => o.type).filter(Boolean))];
    if (types.length > 1) note = ` (one of: ${types.join(', ')})`;
    s = { ...pick, ...(s.description ? { description: s.description } : {}) };
  }

  let type = s.type;
  if (Array.isArray(type)) {
    const real = type.filter((t: string) => t !== 'null');
    if (real.length > 1) note = ` (one of: ${real.join(', ')})`;
    type = real[0];
  }
  if (!type && (s.properties || s.required)) type = 'object';
  if (!type && s.items) type = 'array';
  if (!type && Array.isArray(s.enum)) type = typeof s.enum[0] === 'number' ? 'number' : 'string';
  if (!type && 'const' in s) type = typeof s.const === 'number' ? 'number' : typeof s.const === 'boolean' ? 'boolean' : 'string';

  const out: Schema = {};
  if (type) out.type = type;
  const description = [s.description ?? s.title, note.trim()].filter(Boolean).join(' ');
  if (description) out.description = description;
  if (Array.isArray(s.enum)) out.enum = s.enum.filter((v: unknown) => v !== null);
  else if ('const' in s && s.const !== null) out.enum = [s.const];
  if (out.enum && type === 'string') out.enum = out.enum.map(String);
  for (const key of ['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength'] as const) {
    if (typeof s[key] === 'number') out[key] = s[key];
  }
  if (s.default !== undefined && (typeof s.default !== 'object' || s.default === null) && s.default !== null) out.default = s.default;

  if (type === 'object') {
    out.properties = {};
    for (const [name, prop] of Object.entries((s.properties ?? {}) as Record<string, unknown>)) {
      out.properties[name] = simplifySchema(prop, root, depth + 1);
    }
    const required = Array.isArray(s.required) ? s.required.filter((r: unknown) => typeof r === 'string' && r in out.properties) : [];
    if (required.length) out.required = [...new Set(required)];
  }
  if (type === 'array') out.items = s.items ? simplifySchema(Array.isArray(s.items) ? s.items[0] : s.items, root, depth + 1) : {};
  return out;
}

/** Parameters for a tool: always an object schema at the top. */
function parametersOf(info: McpToolInfo): Schema {
  const schema = simplifySchema(info.inputSchema);
  return schema.type === 'object' ? schema : { type: 'object', properties: {} };
}

/** Turns a tools/call result into the agent's tool outcome, saving images and files to the workspace. */
export async function outcomeOf(
  result: { content?: McpContent[]; structuredContent?: unknown; isError?: boolean },
  ctx: Parameters<Tool['run']>[1],
  label: string
): Promise<ToolOutcome> {
  const texts: string[] = [];
  const images: ImagePart[] = [];
  const files: string[] = [];
  let n = 0;
  const save = async (bytes: Uint8Array, mimeType: string | undefined, name?: string) => {
    n++;
    const base = safeName(name?.split('/').pop() || `${label}-${n}`);
    const ext = extOf(base) ? '' : (MIME_EXT[mimeType ?? ''] ?? '');
    const { path } = await saveDownload({ ws: ctx.workspace, conversationId: ctx.conversationId, bytes, name: `${base}${ext}`, dir: 'mcp' });
    files.push(path);
    return path;
  };

  for (const item of result.content ?? []) {
    switch (item.type) {
      case 'text':
        texts.push(item.text);
        break;
      case 'image': {
        const path = await save(fromBase64(item.data), item.mimeType);
        try {
          images.push(await importAsset({ uri: ctx.workspace.fileAt(path).uri }));
        } catch {}
        texts.push(`[Image saved to ${path}]`);
        break;
      }
      case 'audio':
        texts.push(`[Audio saved to ${await save(fromBase64(item.data), item.mimeType)}]`);
        break;
      case 'resource':
        if (item.resource.text != null) texts.push(`[${item.resource.uri}]\n${item.resource.text}`);
        else if (item.resource.blob) texts.push(`[${item.resource.uri} saved to ${await save(fromBase64(item.resource.blob), item.resource.mimeType, item.resource.uri)}]`);
        break;
      case 'resource_link':
        texts.push(`Link: ${item.name ? `${item.name} — ` : ''}${item.uri}${item.description ? `\n${item.description}` : ''}`);
        break;
    }
  }
  if (!texts.length && result.structuredContent !== undefined) texts.push(JSON.stringify(result.structuredContent, null, 1));
  return {
    output: clip(texts.join('\n\n') || (result.isError ? 'The tool failed without saying why.' : 'Done (no output).')),
    ...(result.isError ? { isError: true } : {}),
    ...(images.length ? { images } : {}),
    ...(files.length ? { files } : {}),
  };
}

function toolFor(provider: ProviderId, info: McpToolInfo): Tool {
  return {
    name: info.key,
    description: (info.description || info.title).slice(0, MAX_DESCRIPTION),
    parameters: parametersOf(info),
    async run(input, ctx) {
      const result = await callMcpTool(provider, info.name, input ?? {}, ctx.signal);
      return outcomeOf(result, ctx, mcpConfig(provider)?.prefix ?? provider);
    },
  };
}

let cache: { from: unknown; tools: Tool[] } | null = null;

/** Every connected MCP server's tools; whether each is offered is up to the plugin catalog. */
export function mcpTools(): Tool[] {
  const mcp = usePlugins.getState().mcp;
  if (cache?.from === mcp) return cache.tools;
  const tools = PLUGINS.flatMap((p) => {
    if (!mcpConfig(p.provider)) return [];
    return (mcp[p.provider]?.tools ?? []).map((info) => toolFor(p.provider, info));
  });
  cache = { from: mcp, tools };
  return tools;
}

export const isMcpTool = (name: string) => mcpTools().some((t) => t.name === name);
