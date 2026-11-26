import { uid } from '../storage';
import {
  ANTIGRAVITY_USER_AGENT,
  ANTIGRAVITY_VERSION,
  bootstrapAntigravityProject,
  buildAntigravityEnvelope,
  CLOUDCODE_HOSTS,
  fetchAntigravityModels,
  getValidCredentials,
  parseAntigravityRetryMs,
  subscriptionAuth,
  type SubscriptionCredentials,
} from '../subscriptions';
import { fetch } from '@/lib/net';
import { guessEfforts } from './effort';
import { thinkingConfig, toGemini } from './gemini';
import { ProviderError, readSSE } from './http';
import { withSubscriptionAccount } from './subscriptionRoute';
import type { Endpoint, ModelInfo, ProviderAdapter, StreamUsage, ToolCall, ToolSpec, WireMessage } from './types';

// The "Recommended" catalog agy 1.5.17 showed (Nov 2026), used when fetchAvailableModels is unreachable.
const FALLBACK_MODELS: ModelInfo[] = [
  'gemini-4-neon-high',
  'gemini-4-neon-xhigh',
  'gemini-4-neon-medium',
  'gemini-4-neon-low',
  'gemini-4-carbon-medium',
  'gemini-4-carbon-high',
  'gemini-4-carbon-low',
  'gemini-4-hydrogen-high',
  'gemini-4-hydrogen-xhigh',
  'gemini-4-hydrogen-medium',
  'gemini-4-hydrogen-low',
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-opus-5-5-low',
  'claude-opus-5-5-medium',
  'claude-opus-5-5-high',
  'claude-sonnet-5-5-low',
  'claude-sonnet-5-5-medium',
  'claude-sonnet-5-5-high',
].map((id) => ({ id, efforts: guessEfforts('antigravity', id), contextLength: 1_048_576 }));

async function ensureProject(
  endpoint: Endpoint,
  account: { id: string },
  creds: SubscriptionCredentials
): Promise<string> {
  if (creds.accountId) return creds.accountId;
  const info = await bootstrapAntigravityProject(creds.accessToken);
  // Persist so later turns (and the usage fetch) skip the bootstrap round-trip.
  await subscriptionAuth.set(endpoint.id, { ...creds, accountId: info.projectId, plan: info.planLabel ?? creds.plan }, account.id);
  return info.projectId;
}

function buildRequest(
  model: string,
  messages: WireMessage[],
  system: string | undefined,
  effort: string | undefined,
  tools: ToolSpec[] | undefined
): Record<string, unknown> {
  return {
    contents: messages.map(toGemini),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(tools?.length
      ? {
          tools: [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
            },
          ],
        }
      : {}),
    ...(effort ? { generationConfig: { thinkingConfig: thinkingConfig(model, effort) } } : {}),
  };
}

async function streamFrom(host: string, accessToken: string, envelope: Record<string, unknown>, signal: AbortSignal) {
  const res = await fetch(`${host}/v1internal:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': ANTIGRAVITY_USER_AGENT,
    },
    body: JSON.stringify(envelope),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let message = body.trim().slice(0, 300);
    try {
      const json = JSON.parse(body);
      const err = typeof json?.error === 'string' ? json.error : json?.error?.message;
      if (err) message = String(err);
    } catch {}
    // Google only puts the cooldown countdown in the 429 body prose.
    const retryAfterMs = res.status === 429 ? parseAntigravityRetryMs(message) : undefined;
    throw new ProviderError(
      `${res.status} ${res.statusText || 'Error'}${message ? `: ${message}` : ''}`,
      res.status,
      retryAfterMs
    );
  }
  return res;
}

export const antigravity: ProviderAdapter = {
  async listModels(endpoint) {
    return withSubscriptionAccount(endpoint, {}, async (account) => {
      const run = async (forceRefresh: boolean): Promise<ModelInfo[]> => {
        const creds = await getValidCredentials(endpoint, { accountId: account.id, forceRefresh });
        try {
          const projectId = await ensureProject(endpoint, account, creds);
          const entries = await fetchAntigravityModels(creds.accessToken, projectId);
          return entries.map((entry) => ({
            id: entry.id,
            efforts: guessEfforts('antigravity', entry.id),
            ...(entry.contextLength ? { contextLength: entry.contextLength } : {}),
          }));
        } catch (e) {
          if (e instanceof ProviderError && e.status === 401 && !forceRefresh && creds.refreshToken) return run(true);
          if (e instanceof ProviderError && (e.status === 401 || e.status === 429)) throw e;
          console.warn('[antigravity] model catalog fetch failed, using fallback list:', e instanceof Error ? e.message : String(e));
          return FALLBACK_MODELS;
        }
      };
      const models = await run(false);
      if (!models.length) console.warn('[antigravity] model catalog came back empty, using fallback list');
      return { models: models.length ? models : FALLBACK_MODELS };
    });
  },

  async stream({ endpoint, model, messages, system, effort, tools, signal, onToken, onReasoning, onToolDraft }) {
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
      const run = async (forceRefresh: boolean): Promise<{ toolCalls: ToolCall[]; usage?: StreamUsage }> => {
        const creds = await getValidCredentials(endpoint, { accountId: account.id, forceRefresh });
        const projectId = await ensureProject(endpoint, account, creds);
        const request = buildRequest(model, messages, system, effort, tools);

        // Walks the host mirrors; only falls through to the next host when nothing has streamed yet.
        const open = async (envelope: Record<string, unknown>) => {
          let res: Awaited<ReturnType<typeof streamFrom>> | null = null;
          let lastError: unknown;
          for (const host of CLOUDCODE_HOSTS) {
            try {
              res = await streamFrom(host, creds.accessToken, envelope, signal);
              break;
            } catch (e) {
              lastError = e;
              const mirrorable =
                started === false &&
                (!(e instanceof ProviderError) || e.status === 404 || e.status === 429 || (e.status ?? 0) >= 500);
              if (!mirrorable || host === CLOUDCODE_HOSTS[CLOUDCODE_HOSTS.length - 1]) throw e;
            }
          }
          if (!res) throw lastError instanceof Error ? lastError : new ProviderError('Antigravity request failed', 0);
          return res;
        };

        let res: Awaited<ReturnType<typeof streamFrom>>;
        try {
          res = await open(buildAntigravityEnvelope(model, projectId, request));
        } catch (e) {
          if (e instanceof ProviderError && e.status === 401 && !forceRefresh && creds.refreshToken) return run(true);
          // Some catalog models reject thinkingConfig with 400; retry once without it.
          if (e instanceof ProviderError && e.status === 400 && request.generationConfig) {
            const { generationConfig: _drop, ...bare } = request;
            res = await open(buildAntigravityEnvelope(model, projectId, bare));
          } else throw e;
        }

        const toolCalls: ToolCall[] = [];
        let usage: StreamUsage | undefined;
        for await (const data of readSSE(res)) {
          let json: any;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          const chunk = json?.response ?? json;
          const err = chunk?.error ?? json?.error;
          if (err) {
            const message = typeof err === 'string' ? err : (err?.message ?? 'Antigravity stream error');
            throw new ProviderError(String(message), typeof err?.code === 'number' ? err.code : undefined);
          }
          const u = chunk?.usageMetadata;
          if (u) {
            usage = {
              output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
              input: u.promptTokenCount,
              cached: u.cachedContentTokenCount ?? 0,
            };
          }
          for (const part of chunk?.candidates?.[0]?.content?.parts ?? []) {
            if (part.functionCall) {
              const call = {
                id: part.functionCall.id ?? `call_${uid()}`,
                name: part.functionCall.name,
                input: part.functionCall.args ?? {},
                signature: part.thoughtSignature,
              };
              emitDraft?.({ index: toolCalls.length, id: call.id, name: call.name, args: JSON.stringify(call.input) });
              toolCalls.push(call);
            }
            if (!part.text) continue;
            // Version-gated accounts get this boilerplate as a normal 200 completion.
            if (!part.thought && /no longer supported/i.test(part.text) && !started) {
              throw new ProviderError(
                `Antigravity rejected client version ${ANTIGRAVITY_VERSION}. Update ANTIGRAVITY_VERSION in src/lib/subscriptions/cloudcode.ts to the current Antigravity CLI (agy) release.`,
                410
              );
            }
            if (part.thought) emitReasoning?.(part.text);
            else emitToken(part.text);
          }
        }
        return { toolCalls, usage };
      };
      return run(false);
    });
  },
};
