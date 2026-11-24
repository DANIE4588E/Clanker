import { useSubscriptionUsage } from '@/store/subscriptionUsage';
import {
  accountUsageKey,
  CLAUDE_CODE_USER_AGENT,
  CLAUDE_MESSAGES_BETA,
  CLAUDE_OAUTH_BETA,
  getValidCredentials,
  parseClaudeUsageHeaders,
  type SubscriptionCredentials,
} from '../subscriptions';
import {
  buildAnthropicBody,
  consumeAnthropicStream,
  effortsOfAnthropicModel,
  type AnthropicModel,
} from './anthropic';
import { getJson, joinUrl, ProviderError, request } from './http';
import { withSubscriptionAccount } from './subscriptionRoute';
import type { Endpoint, ModelInfo, ProviderAdapter } from './types';

const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-4-6', efforts: ['low', 'medium', 'high', 'max'], contextLength: 200_000 },
  { id: 'claude-opus-4-6', efforts: ['low', 'medium', 'high', 'max'], contextLength: 200_000 },
  { id: 'claude-haiku-4-5-20251001', efforts: ['low', 'medium', 'high'], contextLength: 200_000 },
];

function oauthHeaders(endpoint: Endpoint, creds: SubscriptionCredentials, beta: string): Record<string, string> {
  return {
    Authorization: `Bearer ${creds.accessToken}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': beta,
    'User-Agent': CLAUDE_CODE_USER_AGENT,
    'x-app': 'cli',
    ...endpoint.headers,
  };
}

export const claudeSub: ProviderAdapter = {
  async listModels(endpoint) {
    return withSubscriptionAccount(endpoint, {}, (account) => {
      const run = async (forceRefresh: boolean): Promise<{ models: ModelInfo[] }> => {
        const creds = await getValidCredentials(endpoint, { accountId: account.id, forceRefresh });
        try {
          const json = await getJson(
            joinUrl(endpoint.baseUrl, 'v1/models?limit=1000'),
            oauthHeaders(endpoint, creds, CLAUDE_OAUTH_BETA)
          );
          const models = ((json.data ?? []) as AnthropicModel[]).map((m) => ({
            id: m.id,
            efforts: effortsOfAnthropicModel(m),
            contextLength: m.max_input_tokens,
          }));
          return { models: models.length ? models : FALLBACK_MODELS };
        } catch (e) {
          if (e instanceof ProviderError && e.status === 401 && !forceRefresh && creds.refreshToken) {
            return run(true);
          }
          if (e instanceof ProviderError && (e.status === 401 || e.status === 429)) throw e;
          return { models: FALLBACK_MODELS };
        }
      };
      return run(false);
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
      const run = async (forceRefresh: boolean) => {
        const creds = await getValidCredentials(endpoint, { accountId: account.id, forceRefresh });
        const body = buildAnthropicBody({
          endpoint,
          model,
          messages,
          system,
          systemPrefix: CLAUDE_CODE_SYSTEM_PREFIX,
          effort,
          tools,
        });

        let res;
        try {
          res = await request(joinUrl(endpoint.baseUrl, 'v1/messages?beta=true'), {
            headers: { Accept: 'text/event-stream', ...oauthHeaders(endpoint, creds, CLAUDE_MESSAGES_BETA) },
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
        const updated = parseClaudeUsageHeaders(res.headers, usageStore.byAccount[key]);
        if (updated) usageStore.setAccountUsage(endpoint.id, account.id, updated);

        return consumeAnthropicStream(res, {
          onToken: emitToken,
          onReasoning: emitReasoning,
          onToolDraft: emitDraft,
        });
      };

      return run(false);
    });
  },
};
