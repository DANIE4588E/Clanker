import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useBackends } from '@/store/backends';
import { unloadedSummary, useChats, type Conversation } from '@/store/chats';
import { useSettings } from '@/store/settings';
import { usageBuckets, type UsageBucket } from './chatIndex';

export const DAY = 24 * 60 * 60 * 1000;

/** One reply's usage: the tokens it sent and got back over all its model responses. */
export type UsageEvent = {
  at: number;
  /** Local-midnight timestamp of the day it happened. */
  day: number;
  conversationId: string;
  model: string;
  provider: string;
  input: number;
  output: number;
  cached: number;
  /** Prompt tokens of the responses that said how many of them were cached. */
  cacheable: number;
  requests: number;
};

export const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);

/** Calendar-safe day arithmetic (a day across a DST change isn't 24 hours). */
export const addDays = (day: number, n: number) => {
  const d = new Date(day);
  d.setDate(d.getDate() + n);
  return d.setHours(0, 0, 0, 0);
};

/** A chat's usage by span and model: from the chat list for a chat not loaded, so none is read for it. */
function bucketsOf(c: Conversation): UsageBucket[] {
  const unloaded = unloadedSummary(c);
  return unloaded ? (unloaded.u ?? []) : usageBuckets(c.messages);
}

// A chat's events, by its buckets (which stay the same object until its replies change).
const eventCache = new WeakMap<UsageBucket[], { id: string; model: string; provider: string; events: UsageEvent[] }>();

function chatEvents(c: Conversation, provider: string): UsageEvent[] {
  const buckets = bucketsOf(c);
  const hit = eventCache.get(buckets);
  if (hit && hit.id === c.id && hit.model === c.model && hit.provider === provider) return hit.events;
  const events = buckets.map(([at, model, input, output, cached, cacheable, requests]) => ({
    at,
    day: startOfDay(at),
    conversationId: c.id,
    model: model ?? c.model,
    provider,
    input,
    output,
    cached,
    cacheable,
    requests,
  }));
  eventCache.set(buckets, { id: c.id, model: c.model, provider, events });
  return events;
}

/**
 * The usage of every assistant reply in the saved chats. Replies with per-response numbers
 * (see lib/stats) count them; the rest, such as remote replies, estimate their output from the
 * text they streamed. Each event sums a chat's replies with one model over a quarter of an hour
 * (see lib/chatIndex), which adds up to the same days, models and totals as one per reply.
 */
export function usageEvents(
  conversations: Record<string, Conversation>,
  providerOf: (c: Conversation) => string
): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (const c of Object.values(conversations)) events.push(...chatEvents(c, providerOf(c)));
  return events.sort((a, b) => a.at - b.at);
}

/**
 * Usage events of every chat, kept current as replies finish (when their last numbers come in)
 * without recounting on every streamed token, nor reading chats that aren't loaded.
 */
export function useUsageEvents(): UsageEvent[] {
  const signature = useChats(
    useShallow((s) =>
      Object.values(s.conversations).flatMap((c): unknown[] => {
        const unloaded = unloadedSummary(c);
        if (unloaded) return [c.id, unloaded];
        const last = c.messages[c.messages.length - 1];
        return [c.id, c.messages.length, last?.status, last?.steps?.length ?? 0];
      })
    )
  );
  const endpoints = useSettings((s) => s.endpoints);
  const remotes = useBackends((s) => s.remotes);
  return useMemo(() => {
    const names = new Map<string, string>([
      ...endpoints.map((e) => [e.id, e.name] as const),
      ...remotes.map((b) => [b.id, b.name] as const),
    ]);
    return usageEvents(useChats.getState().conversations, (c) =>
      c.backendId && c.backendId !== 'local'
        ? names.get(c.backendId) ?? 'Remote backend'
        : names.get(c.endpointId) ?? 'Removed provider'
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, endpoints, remotes]);
}

export const tokensOf = (e: Pick<UsageEvent, 'input' | 'output'>) => e.input + e.output;

/** Tokens per local day. */
export function dailyTotals(events: UsageEvent[]): Map<number, number> {
  const days = new Map<number, number>();
  for (const e of events) days.set(e.day, (days.get(e.day) ?? 0) + tokensOf(e));
  return days;
}

export type Share = { key: string; label: string; sub?: string; tokens: number; children?: Share[] };

export type UsageSummary = {
  tokens: number;
  input: number;
  output: number;
  cached: number;
  cacheHit: number | null;
  sessions: number;
  requests: number;
  activeDays: number;
  models: Share[];
  providers: Share[];
  /** Per day from `from` to today: tokens by model key, and that day's cache hit rate. */
  days: { day: number; byModel: Record<string, number>; total: number; cacheHit: number | null }[];
};

export const modelKey = (e: Pick<UsageEvent, 'provider' | 'model'>) => `${e.provider}/${e.model}`;

/** Totals of the events from `from` (a local midnight) on. */
export function summarize(all: UsageEvent[], from: number): UsageSummary {
  const events = all.filter((e) => e.day >= from);
  const models = new Map<string, Share>();
  const providers = new Map<string, Share & { modelKeys: Set<string> }>();
  const days = new Map<number, { byModel: Record<string, number>; total: number; cached: number; cacheable: number }>();
  let cached = 0;
  let cacheable = 0;
  let requests = 0;
  for (const e of events) {
    const t = tokensOf(e);
    const key = modelKey(e);
    cached += e.cached;
    cacheable += e.cacheable;
    requests += e.requests;

    const m = models.get(key) ?? { key, label: e.model, sub: e.provider, tokens: 0 };
    m.tokens += t;
    models.set(key, m);

    const p = providers.get(e.provider) ?? { key: e.provider, label: e.provider, tokens: 0, modelKeys: new Set() };
    p.tokens += t;
    p.modelKeys.add(key);
    providers.set(e.provider, p);

    const d = days.get(e.day) ?? { byModel: {}, total: 0, cached: 0, cacheable: 0 };
    d.byModel[key] = (d.byModel[key] ?? 0) + t;
    d.total += t;
    d.cached += e.cached;
    d.cacheable += e.cacheable;
    days.set(e.day, d);
  }

  const byTokens = (a: Share, b: Share) => b.tokens - a.tokens;
  const start = events.length ? Math.max(from, events[0].day) : startOfDay(Date.now());
  const today = startOfDay(Date.now());
  const series: UsageSummary['days'] = [];
  for (let day = Math.min(start, today); day <= today; day = addDays(day, 1)) {
    const d = days.get(day);
    series.push({
      day,
      byModel: d?.byModel ?? {},
      total: d?.total ?? 0,
      cacheHit: d?.cacheable ? d.cached / d.cacheable : null,
    });
  }

  return {
    tokens: events.reduce((n, e) => n + tokensOf(e), 0),
    input: events.reduce((n, e) => n + e.input, 0),
    output: events.reduce((n, e) => n + e.output, 0),
    cached,
    cacheHit: cacheable ? cached / cacheable : null,
    sessions: new Set(events.map((e) => e.conversationId)).size,
    requests,
    activeDays: days.size,
    models: [...models.values()].sort(byTokens),
    providers: [...providers.values()]
      .map(({ modelKeys, ...p }) => ({
        ...p,
        sub: `${modelKeys.size} ${modelKeys.size === 1 ? 'model' : 'models'}`,
        children: [...modelKeys].map((k) => models.get(k)!).sort(byTokens),
      }))
      .sort(byTokens),
    days: series,
  };
}

/** 4.6K, 1.2M, 289.3M. */
export function compactTokens(n: number) {
  const short = (x: number) => String(Number(x.toFixed(x >= 10 ? 1 : 2)));
  if (n >= 1e9) return `${short(n / 1e9)}B`;
  if (n >= 1e6) return `${short(n / 1e6)}M`;
  if (n >= 1e3) return `${short(n / 1e3)}K`;
  return String(Math.round(n));
}

