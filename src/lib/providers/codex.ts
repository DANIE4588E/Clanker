import { fetch } from '@/lib/net';
import { useSubscriptionUsage } from '@/store/subscriptionUsage';
import { uid } from '../storage';
import {
  accountUsageKey,
  getValidCredentials,
  parseCodexUsageHeaders,
  type SubscriptionCredentials,
} from '../subscriptions';
import { guessEfforts } from './effort';
import { getJson, joinUrl, ProviderError, readSSE, request } from './http';
import { withSubscriptionAccount } from './subscriptionRoute';
import type { Endpoint, ModelInfo, ProviderAdapter, StreamUsage, ToolCall, WireMessage } from './types';

const DEFAULT_CODEX_CLIENT_VERSION = '0.172.0';
const VERSION_CACHE_MS = 6 * 60 * 60 * 1000;
let cachedClientVersion: { version: string; at: number } | null = null;

/**
 * Resolves the latest published `@openai/codex` version (cached for 6h, 2.5s timeout) so
 * `/backend-api/codex/models?client_version=...` never gates out newly released models.
 */
async function resolveCodexClientVersion(): Promise<string> {
  if (cachedClientVersion && Date.now() - cachedClientVersion.at < VERSION_CACHE_MS) {
    return cachedClientVersion.version;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch('https://registry.npmjs.org/@openai/codex/latest', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.ok) {
      const json = (await res.json()) as { version?: unknown };
      if (typeof json?.version === 'string' && /^\d+\.\d+\.\d+/.test(json.version.trim())) {
        const version = json.version.trim();
        cachedClientVersion = { version, at: Date.now() };
        return version;
      }
    }
  } catch {
    // Offline or slow registry: fall back to the bundled version.
  } finally {
    clearTimeout(timer);
  }
  return cachedClientVersion?.version ?? DEFAULT_CODEX_CLIENT_VERSION;
}

const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'gpt-5.4', efforts: ['low', 'medium', 'high', 'xhigh'], contextLength: 272_000 },
  { id: 'gpt-5.3-codex', efforts: ['low', 'medium', 'high', 'xhigh'], contextLength: 272_000 },
  { id: 'gpt-5.2-codex', efforts: ['low', 'medium', 'high', 'xhigh'], contextLength: 272_000 },
  { id: 'gpt-5.1-codex-max', efforts: ['low', 'medium', 'high', 'xhigh'], contextLength: 272_000 },
  { id: 'gpt-5.1-codex-mini', efforts: ['low', 'medium', 'high'], contextLength: 272_000 },
];

type CodexModelEntry = {
  slug?: string;
  id?: string;
  visibility?: string;
  supported_in_api?: boolean;
  priority?: number;
  context_window?: number;
  supported_reasoning_levels?: ({ effort?: string } | string)[];
};

function codexHeaders(endpoint: Endpoint, creds: SubscriptionCredentials, clientVersion: string): Record<string, string> {
  return {
    Authorization: `Bearer ${creds.accessToken}`,
    ...(creds.accountId ? { 'ChatGPT-Account-Id': creds.accountId } : {}),
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    'User-Agent': `codex_cli_rs/${clientVersion}`,
    ...endpoint.headers,
  };
}

function parseEfforts(entry: CodexModelEntry, id: string): string[] | undefined {
  if (Array.isArray(entry.supported_reasoning_levels) && entry.supported_reasoning_levels.length) {
    const levels = entry.supported_reasoning_levels
      .map((l) => (typeof l === 'string' ? l : l?.effort))
      .filter((l): l is string => typeof l === 'string' && !!l);
    if (levels.length) return [...new Set(levels)];
  }
  return guessEfforts('codex', id);
}

/** Converts Clanker WireMessages to OpenAI Responses API `input` items. */
export function toCodexInput(messages: WireMessage[]): object[] {
  const out: object[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const results = m.results ?? [];
      const images = results.flatMap((r) => r.images ?? []);
      for (const r of results) {
        out.push({
          type: 'function_call_output',
          call_id: r.callId,
          output: r.output || '(no output)',
        });
      }
      if (images.length) {
        out.push({
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Images returned by the tool calls above:' },
            ...images.map((img) => ({
              type: 'input_image',
              image_url: `data:${img.mimeType};base64,${img.base64}`,
            })),
          ],
        });
      }
      continue;
    }

    if (m.role === 'assistant') {
      if (m.text) {
        out.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: m.text }],
        });
      }
      for (const c of m.toolCalls ?? []) {
        out.push({
          type: 'function_call',
          call_id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.input),
        });
      }
      continue;
    }

    const content: object[] = [
      ...m.images.map((img) => ({
        type: 'input_image',
        image_url: `data:${img.mimeType};base64,${img.base64}`,
      })),
      ...(m.text ? [{ type: 'input_text', text: m.text }] : []),
    ];
    if (content.length) {
      out.push({ type: 'message', role: 'user', content });
    }
  }
  return out;
}

export const codex: ProviderAdapter = {
  async listModels(endpoint) {
    const clientVersion = await resolveCodexClientVersion();
    return withSubscriptionAccount(endpoint, {}, (account) => {
      const run = async (forceRefresh: boolean): Promise<{ models: ModelInfo[] }> => {
        const creds = await getValidCredentials(endpoint, { accountId: account.id, forceRefresh });
        try {
          const json = await getJson(
            joinUrl(endpoint.baseUrl, `models?client_version=${encodeURIComponent(clientVersion)}`),
            { Accept: 'application/json', ...codexHeaders(endpoint, creds, clientVersion) }
          );
          const raw: CodexModelEntry[] = Array.isArray(json?.models)
            ? json.models
            : Array.isArray(json?.data)
              ? json.data
              : [];
          const sorted = [...raw].sort(
            (a, b) => (typeof a.priority === 'number' ? a.priority : 999) - (typeof b.priority === 'number' ? b.priority : 999)
          );
          const models: ModelInfo[] = sorted
            .filter((m) => m.visibility !== 'hide' && m.supported_in_api !== false)
            .flatMap((m): ModelInfo[] => {
              const id = String(m.slug ?? m.id ?? '').trim();
              if (!id) return [];
              const efforts = parseEfforts(m, id);
              return [
                {
                  id,
                  ...(efforts ? { efforts } : {}),
                  contextLength: typeof m.context_window === 'number' ? m.context_window : 272_000,
                },
              ];
            });
          return { models: models.length ? models : FALLBACK_MODELS };
        } catch (e) {
          if (e instanceof ProviderError && e.status === 401 && !forceRefresh && creds.refreshToken) {
            return run(true);
          }
          throw e;
        }
      };
      return run(false);
    });
  },

  async stream({ endpoint, model, messages, system, effort, tools, signal, onToken, onReasoning, onToolDraft }) {
    const clientVersion = cachedClientVersion?.version ?? DEFAULT_CODEX_CLIENT_VERSION;
    let started = false;
    const emitToken = (t: string) => {
      started = true;
      onToken(t);
    };
    const emitReasoning = onReasoning
      ? (t: string) => {
          started = true;
          onReasoning(t);
        }
      : undefined;
    const emitDraft = onToolDraft
      ? (d: { index: number; id: string; name: string; args: string }) => {
          started = true;
          onToolDraft(d);
        }
      : undefined;

    return withSubscriptionAccount(endpoint, { model, signal, hasStarted: () => started }, (account) => {
      const run = async (forceRefresh: boolean) => {
        const creds = await getValidCredentials(endpoint, { accountId: account.id, forceRefresh });
        const body: Record<string, unknown> = {
          model,
          instructions: system?.trim() || 'You are a helpful assistant.',
          input: toCodexInput(messages),
          store: false,
          stream: true,
          ...(effort ? { reasoning: { effort, summary: 'auto' } } : {}),
          ...(tools?.length
            ? {
                tools: tools.map((t) => ({
                  type: 'function',
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                })),
                tool_choice: 'auto',
                parallel_tool_calls: true,
              }
            : {}),
        };

        let res;
        try {
          res = await request(joinUrl(endpoint.baseUrl, 'responses'), {
            headers: { Accept: 'text/event-stream', ...codexHeaders(endpoint, creds, clientVersion) },
            body,
            signal,
          });
        } catch (e) {
          if (e instanceof ProviderError && e.status === 401 && !forceRefresh && creds.refreshToken) {
            return run(true);
          }
          throw e;
        }

        const usageStore = useSubscriptionUsage.getState();
        const key = accountUsageKey(endpoint.id, account.id);
        const updated = parseCodexUsageHeaders(res.headers, usageStore.byAccount[key]);
        if (updated) usageStore.setAccountUsage(endpoint.id, account.id, updated);

        const callsByIndex = new Map<number, { id: string; name: string; args: string; itemId?: string }>();
        const indexByItemId = new Map<string, number>();
        let usage: StreamUsage | undefined;

        for await (const data of readSSE(res)) {
          if (!data || data === '[DONE]') continue;
          let event: any;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }
          const type = event.type;
          if (type === 'error' || type === 'response.failed') {
            const msg = event.error?.message ?? event.response?.error?.message ?? event.message ?? 'Codex stream error';
            throw new Error(String(msg));
          }
          if (type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) {
            emitToken(event.delta);
          } else if (
            (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') &&
            typeof event.delta === 'string' &&
            event.delta
          ) {
            emitReasoning?.(event.delta);
          } else if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
            const index = typeof event.output_index === 'number' ? event.output_index : callsByIndex.size;
            const id = String(event.item.call_id ?? event.item.id ?? `call_${uid()}`);
            const name = String(event.item.name ?? '');
            const args = typeof event.item.arguments === 'string' ? event.item.arguments : '';
            callsByIndex.set(index, { id, name, args, itemId: event.item.id });
            if (event.item.id) indexByItemId.set(String(event.item.id), index);
            if (name) emitDraft?.({ index, id, name, args });
          } else if (type === 'response.function_call_arguments.delta') {
            const index =
              typeof event.output_index === 'number'
                ? event.output_index
                : event.item_id != null
                  ? indexByItemId.get(String(event.item_id))
                  : undefined;
            if (index != null) {
              const call = callsByIndex.get(index);
              if (call) {
                call.args += typeof event.delta === 'string' ? event.delta : '';
                if (call.name) emitDraft?.({ index, id: call.id, name: call.name, args: call.args });
              }
            }
          } else if (type === 'response.function_call_arguments.done') {
            const index =
              typeof event.output_index === 'number'
                ? event.output_index
                : event.item_id != null
                  ? indexByItemId.get(String(event.item_id))
                  : undefined;
            if (index != null) {
              const call = callsByIndex.get(index);
              if (call && typeof event.arguments === 'string') call.args = event.arguments;
            }
          } else if (type === 'response.output_item.done' && event.item?.type === 'function_call') {
            const index = typeof event.output_index === 'number' ? event.output_index : callsByIndex.size;
            const existing = callsByIndex.get(index);
            const id = String(event.item.call_id ?? existing?.id ?? `call_${uid()}`);
            const name = String(event.item.name ?? existing?.name ?? '');
            const args = typeof event.item.arguments === 'string' ? event.item.arguments : existing?.args ?? '';
            callsByIndex.set(index, { id, name, args, itemId: event.item.id });
          } else if (type === 'response.completed' || type === 'response.done') {
            const u = event.response?.usage;
            if (u) {
              usage = {
                input: u.input_tokens,
                output: u.output_tokens,
                cached: u.input_tokens_details?.cached_tokens ?? 0,
              };
            }
          }
        }

        const toolCalls: ToolCall[] = [...callsByIndex.values()]
          .filter((c) => c.name)
          .map((c) => {
            let input: Record<string, unknown> = {};
            try {
              input = c.args ? JSON.parse(c.args) : {};
            } catch {
              input = { _raw: c.args };
            }
            return { id: c.id, name: c.name, input };
          });

        return { toolCalls, usage };
      };

      return run(false);
    });
  },
};
