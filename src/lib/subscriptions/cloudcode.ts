/**
 * Client for the Cloud Code Assist API (`cloudcode-pa.googleapis.com/v1internal`) that backs the
 * Google Antigravity subscription. Shapes follow the open-source gemini-cli `code_assist` package
 * and the Antigravity IDE's own traffic; the API is a moving target, so parsers are defensive.
 */
import { Platform } from 'react-native';
import { fetch } from '@/lib/net';
import { ProviderError } from '../providers/http';
import { randomUuid } from './pkce';
import type { SubscriptionUsage, UsageWindow } from './usage';

/**
 * Host chain, tried in order. Counter-intuitively the *daily* host is the live Antigravity surface:
 * the prod host version-gates the 2.11.0 client — every generation 429s with RESOURCE_EXHAUSTED even
 * while `retrieveUserQuota` on prod still reports full buckets (verified live, 2026-11-26). Daily
 * returns the working generations, the honest quota buckets, and the same catalog, so it goes first
 * and prod is only a fallback. Quota pools are per-host, which is why `postCloudCode` also mirrors
 * on 429.
 */
export const CLOUDCODE_HOSTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
] as const;

/**
 * Antigravity CLI (`agy`) version this client identifies as. The API gates both the model catalog
 * and generation on the User-Agent: the desktop-app identity (`antigravity/<ver> darwin/arm64`)
 * gets a reduced catalog with no Gemini 4 and 404s on Gemini 4 generations, while the CLI identity
 * gets the same full catalog the CLI and IDE show. Old versions get a synthetic "This version of
 * Antigravity is no longer supported" reply instead of a completion — bump this when that appears.
 * Captured from agy 1.5.17's own traffic (2026-11-26).
 */
export const ANTIGRAVITY_VERSION = '1.5.17';

export const ANTIGRAVITY_USER_AGENT = `antigravity/cli/${ANTIGRAVITY_VERSION} (aidev_client; os_type=${
  Platform.OS === 'ios' ? 'ios' : 'android'
}; arch=arm64; auth_method=consumer)`;

/**
 * Client metadata variants tried during bootstrap, best entitlement first. The Cloud Code API
 * rejects unknown enum names with 400, so `bootstrapAntigravityProject` walks this list. The first
 * is exactly what agy sends.
 */
export const CLOACODE_METADATA_VARIANTS = [
  { ideType: 'ANTIGRAVITY' },
  { ideType: 'GEMINI_CLI', platform: 'DARWIN_ARM64', pluginType: 'GEMINI' },
  { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
] as const;

/**
 * Internal catalog ids (tab-jump/autocomplete sentinels, tier routers, worker/experiment models)
 * that appear in the model map and quota buckets but are not user-selectable.
 */
const INTERNAL_MODEL_ID = /^(chat_\d+|tab_|models\/)|-tiered(-|$)|-worker-|-sonar$/;

export type AntigravityAccountInfo = {
  projectId: string;
  tierId?: string;
  planLabel?: string;
};

// ---- Pure parsers (unit-tested) ---------------------------------------------------------------

export function formatCloudCodePlan(tierId: unknown, tierName?: unknown): string | undefined {
  const name = typeof tierName === 'string' ? tierName.trim() : '';
  if (name) return name;
  if (typeof tierId !== 'string' || !tierId.trim()) return undefined;
  const cleaned = tierId
    .trim()
    .toLowerCase()
    .replace(/-tier$/, '')
    .replace(/[-_]+/g, ' ');
  if (!cleaned) return undefined;
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Parses a `v1internal:loadCodeAssist` response. */
export function parseLoadCodeAssist(json: any): {
  projectId?: string;
  tierId?: string;
  planLabel?: string;
  needsOnboard?: boolean;
  defaultTierId?: string;
  ineligibleReason?: string;
} {
  const project = typeof json?.cloudaicompanionProject === 'string' ? json.cloudaicompanionProject : undefined;
  const tier = json?.currentTier;
  const tierId = typeof tier?.id === 'string' ? tier.id : undefined;
  // currentTier is the entitlement Antigravity *runs on* (often 'free-tier' even for paying
  // accounts); paidTier carries the real subscription (e.g. 'Google AI Pro'). Prefer the latter.
  const planLabel = formatCloudCodePlan(json?.paidTier?.id, json?.paidTier?.name) ?? formatCloudCodePlan(tierId, tier?.name);
  if (tierId) return { ...(project ? { projectId: project } : {}), tierId, planLabel };

  const allowed: any[] = Array.isArray(json?.allowedTiers) ? json.allowedTiers : [];
  const defaultTier = allowed.find((t) => t?.isDefault) ?? allowed[0];
  const ineligible: any[] = Array.isArray(json?.ineligibleTiers) ? json.ineligibleTiers : [];
  return {
    needsOnboard: true,
    ...(defaultTier?.id ? { defaultTierId: String(defaultTier.id) } : {}),
    ...(typeof ineligible[0]?.reasonMessage === 'string' ? { ineligibleReason: ineligible[0].reasonMessage } : {}),
  };
}

/** Pulls the project id out of a finished `onboardUser` long-running operation. */
export function parseOnboardOperation(op: any): string | undefined {
  const project = op?.response?.cloudaicompanionProject;
  if (typeof project === 'string' && project) return project;
  if (typeof project?.id === 'string' && project.id) return project.id;
  return undefined;
}

export type AntigravityModelEntry = { id: string; displayName?: string; contextLength?: number };

/**
 * Parses `v1internal:fetchAvailableModels` (`{ models: { [id]: {...} }, agentModelSorts }`).
 * When the server sends `agentModelSorts` (the curated "Recommended" picker the CLI and IDE show),
 * only those models are returned, in that order — the rest of the map is utility models (image
 * generation, commit messages, web search) that don't belong in a chat picker. Without sorts it
 * falls back to every labelled, non-internal model sorted by id.
 */
export function parseAntigravityModels(json: any): AntigravityModelEntry[] {
  const raw = json?.models;
  if (!raw || typeof raw !== 'object') return [];
  const entries: AntigravityModelEntry[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries<any>(raw)) {
    const id = typeof value?.id === 'string' && value.id ? value.id : key;
    if (seen.has(id) || !/^[a-z0-9][a-z0-9._[-]*$/i.test(id)) continue;
    if (INTERNAL_MODEL_ID.test(id)) continue;
    const displayName =
      typeof value?.displayName === 'string' && value.displayName.trim()
        ? value.displayName.trim()
        : typeof value?.name === 'string' && value.name.trim()
          ? value.name.trim()
          : undefined;
    // Entries without any label are internal (routing/sentinel) models that 403 when used.
    if (!displayName) continue;
    const maxTokens = Number(value?.maxTokens ?? value?.maxRequestTokenCount ?? value?.tokenLimit);
    entries.push({
      id,
      displayName,
      ...(Number.isFinite(maxTokens) && maxTokens >= 1000 ? { contextLength: Math.floor(maxTokens) } : {}),
    });
    seen.add(id);
  }
  const sorts: any[] = Array.isArray(json?.agentModelSorts) ? json.agentModelSorts : [];
  const order: string[] = [];
  for (const sort of sorts) {
    for (const group of Array.isArray(sort?.groups) ? sort.groups : []) {
      for (const id of Array.isArray(group?.modelIds) ? group.modelIds : []) {
        if (typeof id === 'string') order.push(id);
      }
    }
  }
  if (order.length) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const picked: AntigravityModelEntry[] = [];
    for (const id of new Set(order)) {
      const entry = byId.get(id);
      if (entry) picked.push(entry);
    }
    if (picked.length) return picked;
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Parses `v1internal:retrieveUserQuotaSummary` — the pooled limits the Antigravity UI shows:
 * groups like "Gemini Models" and "Claude and GPT models", each with a `5h` and a `weekly` bucket.
 * Returns null when nothing usable came back so the caller can fall back to per-model buckets.
 */
export function parseAntigravityQuotaSummary(
  json: any,
  opts?: { email?: string; plan?: string; now?: number }
): SubscriptionUsage | null {
  const now = opts?.now ?? Date.now();
  const groups: any[] = Array.isArray(json?.groups) ? json.groups : [];
  const windowRank = (w: unknown) => (w === '5h' ? 0 : w === 'weekly' ? 1 : 2);
  const windows: UsageWindow[] = [];
  for (const group of groups) {
    const family =
      typeof group?.displayName === 'string'
        ? group.displayName.trim().replace(/\s+models?$/i, '').replace(/\s+and\s+/i, ' & ')
        : '';
    const buckets: any[] = Array.isArray(group?.buckets) ? [...group.buckets] : [];
    // 5-hour before weekly within a group, matching the Codex and Claude cards.
    buckets.sort((a, b) => windowRank(a?.window) - windowRank(b?.window));
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== 'object') continue;
      // proto3 JSON omits zero values, so a fully used bucket arrives without remainingFraction.
      const raw = bucket.remainingFraction ?? 0;
      const frac = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(frac)) continue;
      const remainingPercent = Math.max(0, Math.min(100, Math.round(frac * 100)));
      const period =
        bucket.window === '5h'
          ? '5-hour'
          : bucket.window === 'weekly'
            ? 'weekly'
            : typeof bucket.displayName === 'string' && bucket.displayName.trim()
              ? bucket.displayName.trim()
              : 'limit';
      const resetMs = typeof bucket.resetTime === 'string' ? Date.parse(bucket.resetTime) : NaN;
      windows.push({
        id: typeof bucket.bucketId === 'string' && bucket.bucketId ? bucket.bucketId : `${family || 'quota'}-${period}`,
        label: family ? `${family} · ${period}` : period,
        remainingPercent,
        usedPercent: 100 - remainingPercent,
        ...(Number.isFinite(resetMs) ? { resetsAt: resetMs } : {}),
      });
    }
  }
  if (!windows.length) return null;
  return {
    ...(opts?.plan ? { plan: opts.plan } : {}),
    ...(opts?.email ? { email: opts.email } : {}),
    windows,
    fetchedAt: now,
  };
}

/**
 * Parses `v1internal:retrieveUserQuota` into usage windows. Google reports quotas per model, but
 * the real limits are shared pools per model family (Gemini vs Claude/GPT) with a rolling ~5-hour
 * window and a weekly window, so buckets are aggregated to one bar per family+window; the pool
 * shows its tightest member. Unknown models keep their own bar. Sorted tightest first.
 */
export function parseAntigravityQuota(
  json: any,
  opts?: { email?: string; plan?: string; now?: number }
): SubscriptionUsage {
  const now = opts?.now ?? Date.now();
  const buckets: any[] = Array.isArray(json?.buckets)
    ? json.buckets
    : Array.isArray(json?.modelQuotas)
      ? json.modelQuotas
      : Array.isArray(json?.quotas)
        ? json.quotas
        : [];

  type Pool = { family: 'gemini' | 'thirdparty' | 'other'; period: '5h' | 'weekly' | ''; remainingPercent: number; resetsAt?: number; bottleneck?: string };
  const pools = new Map<string, Pool>();

  for (const bucket of buckets) {
    const fracRaw = bucket?.remainingFraction ?? bucket?.remaining_fraction;
    const frac = typeof fracRaw === 'number' ? fracRaw : Number(fracRaw);
    if (!Number.isFinite(frac)) continue;
    const remainingPercent = Math.max(0, Math.min(100, Math.round(frac * 100)));
    const modelId = typeof bucket?.modelId === 'string' && bucket.modelId ? bucket.modelId : undefined;
    // Internal sentinels (tab/autocomplete chat_* models) always report full; they are not bars.
    if (modelId && INTERNAL_MODEL_ID.test(modelId)) continue;
    const tokenType = typeof bucket?.tokenType === 'string' && bucket.tokenType ? bucket.tokenType : undefined;
    const resetMs = typeof bucket?.resetTime === 'string' ? Date.parse(bucket.resetTime) : NaN;
    const resetsAt = Number.isFinite(resetMs) ? resetMs : undefined;
    const family = familyOfQuotaModel(modelId ?? tokenType);
    const period = family === 'other' ? '' : periodOfQuotaReset(resetsAt, now);
    const key = [family, period, family === 'other' ? (modelId ?? tokenType ?? `bucket_${pools.size}`) : ''].join('|').replace(/\|+$/, '');
    const existing = pools.get(key);
    if (!existing || remainingPercent < existing.remainingPercent) {
      pools.set(key, {
        family,
        period,
        remainingPercent,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(modelId || tokenType ? { bottleneck: (modelId ?? tokenType!).replace(/[-_]/g, ' ') } : {}),
      });
    }
  }

  const windows: UsageWindow[] = [];
  for (const [key, pool] of pools) {
    const familyLabel = pool.family === 'gemini' ? 'Gemini' : pool.family === 'thirdparty' ? 'Claude & GPT' : null;
    const label = familyLabel
      ? pool.period === '5h'
        ? `${familyLabel} · 5-hour`
        : pool.period === 'weekly'
          ? `${familyLabel} · weekly`
          : familyLabel
      : pool.bottleneck ?? 'Quota';
    windows.push({
      id: key,
      label,
      remainingPercent: pool.remainingPercent,
      usedPercent: 100 - pool.remainingPercent,
      ...(pool.resetsAt !== undefined ? { resetsAt: pool.resetsAt } : {}),
      ...(pool.bottleneck && pool.family !== 'other' ? { detail: `lowest: ${pool.bottleneck}` } : {}),
    });
  }
  windows.sort((a, b) => a.remainingPercent - b.remainingPercent);
  return {
    ...(opts?.plan ? { plan: opts.plan } : {}),
    ...(opts?.email ? { email: opts.email } : {}),
    windows,
    fetchedAt: now,
  };
}

function familyOfQuotaModel(modelId?: string): 'gemini' | 'thirdparty' | 'other' {
  const s = (modelId ?? '').toLowerCase();
  if (/gemini|gemma|imagen|veo|banana|embedding|tts|live/.test(s)) return 'gemini';
  if (/claude|anthropic|gpt|o[134][-_]|grok|llama|mistral|deepseek|kimi|qwen/.test(s)) return 'thirdparty';
  return 'other';
}

function periodOfQuotaReset(resetsAt: number | undefined, now: number): '5h' | 'weekly' | '' {
  if (resetsAt === undefined) return '';
  const delta = resetsAt - now;
  if (delta <= 8 * 3_600_000) return '5h';
  if (delta >= 4 * 24 * 3_600_000) return 'weekly';
  return '';
}

/**
 * Parses the quota-reset countdown Google only puts in the 429 body prose,
 * e.g. "Your quota will reset after 2h7m23s".
 */
export function parseAntigravityRetryMs(message: string): number | undefined {
  const m = message.match(/reset after\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s)?/i);
  if (!m) return undefined;
  const [, h, min, s] = m;
  if (!h && !min && !s) return undefined;
  const ms = (Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000;
  return ms > 0 ? ms : undefined;
}

/**
 * Builds the request envelope for `v1internal:streamGenerateContent`. The API strictly validates
 * top-level fields — anything not on this list is rejected with 400 Unknown name.
 */
export function buildAntigravityEnvelope(
  model: string,
  projectId: string | undefined,
  request: Record<string, unknown>,
  userPromptId = randomUuid()
): Record<string, unknown> {
  return {
    model,
    ...(projectId ? { project: projectId } : {}),
    user_prompt_id: userPromptId,
    request,
  };
}

// ---- Network helpers ---------------------------------------------------------------------------

async function readCloudCodeError(res: { status: number; statusText?: string; text(): Promise<string> }, method: string) {
  const body = await res.text().catch(() => '');
  let msg = body.trim().slice(0, 300);
  try {
    const json = JSON.parse(body);
    const err = typeof json?.error === 'string' ? json.error : json?.error?.message;
    if (err) msg = String(err);
  } catch {}
  return new ProviderError(`Antigravity ${method} failed (${res.status})${msg ? `: ${msg}` : ''}`, res.status);
}

async function postCloudCode(accessToken: string, method: string, body: Record<string, unknown>): Promise<any> {
  let lastError: unknown;
  for (const host of CLOUDCODE_HOSTS) {
    try {
      const res = await fetch(`${host}/v1internal:${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': ANTIGRAVITY_USER_AGENT,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // 404/429/5xx on a host: quota pools are per-host (and prod 429s the 2.11.0 client wholesale),
        // so try the mirror; surface everything else.
        if ((res.status === 404 || res.status === 429 || res.status >= 500) && host !== CLOUDCODE_HOSTS[CLOUDCODE_HOSTS.length - 1]) {
          lastError = await readCloudCodeError(res, method);
          continue;
        }
        throw await readCloudCodeError(res, method);
      }
      return await res.json();
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      lastError = err;
      if (host === CLOUDCODE_HOSTS[CLOUDCODE_HOSTS.length - 1]) break;
    }
  }
  if (lastError instanceof ProviderError) throw lastError;
  throw new ProviderError(`Antigravity ${method} failed: network error`, 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls a long-running operation (`v1internal/{name}`) until it finishes. */
async function pollOperation(accessToken: string, name: string, tries = 24, delayMs = 5000): Promise<any> {
  for (let i = 0; i < tries; i++) {
    await sleep(delayMs);
    let lastRes: any;
    for (const host of CLOUDCODE_HOSTS) {
      const res = await fetch(`${host}/v1internal/${encodeURIComponent(name)}`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': ANTIGRAVITY_USER_AGENT },
      }).catch(() => null);
      lastRes = res;
      if (res?.ok) return await res.json();
      if (res && res.status !== 404 && res.status < 500) break;
    }
    if (lastRes && !lastRes.ok) throw await readCloudCodeError(lastRes, 'onboardUser');
  }
  throw new ProviderError('Antigravity onboarding is still running. Try again in a minute.', 503);
}

/**
 * Resolves the project + tier for an Antigravity account, running first-use onboarding when the
 * account has no `cloudaicompanionProject` yet. Mirrors gemini-cli's setup flow.
 */
export async function bootstrapAntigravityProject(accessToken: string): Promise<AntigravityAccountInfo> {
  let parsed: ReturnType<typeof parseLoadCodeAssist> | null = null;
  let metadata: Record<string, unknown> | null = null;
  let lastError: ProviderError | null = null;
  for (const variant of CLOACODE_METADATA_VARIANTS) {
    try {
      const json = await postCloudCode(accessToken, 'loadCodeAssist', { metadata: { ...variant } });
      parsed = parseLoadCodeAssist(json);
      metadata = { ...variant };
      break;
    } catch (err) {
      lastError = err instanceof ProviderError ? err : lastError;
      // 400 = unknown enum name in this variant's metadata; try the next one.
      if (!(err instanceof ProviderError) || err.status !== 400) break;
    }
  }
  if (!parsed) {
    if (lastError) throw lastError;
    throw new ProviderError('Antigravity bootstrap failed: could not load account info.', 500);
  }

  if (parsed.projectId) return { projectId: parsed.projectId, tierId: parsed.tierId, planLabel: parsed.planLabel };
  if (!parsed.needsOnboard) {
    throw new ProviderError(parsed.ineligibleReason ?? 'This Google account is not eligible for Antigravity.', 403);
  }
  if (!metadata) throw new ProviderError('Antigravity bootstrap failed: no usable client metadata.', 500);

  const tierId = parsed.defaultTierId ?? 'free-tier';
  // Passing a project for the free tier fails Precondition Failed; omit it there (gemini-cli does too).
  const onboardBody: Record<string, unknown> = { tierId, metadata };
  const lro = await postCloudCode(accessToken, 'onboardUser', onboardBody);
  const name = typeof lro?.name === 'string' ? lro.name : '';
  if (!name) throw new ProviderError('Antigravity onboarding did not start.', 500);
  const op = await pollOperation(accessToken, name);
  const projectId = parseOnboardOperation(op);
  if (!projectId) {
    throw new ProviderError(op?.error?.message ?? 'Antigravity onboarding did not return a project.', 500);
  }
  return { projectId, tierId, planLabel: formatCloudCodePlan(tierId) };
}

/** Lists the models the account can use (the only model-discovery source on this API). */
export async function fetchAntigravityModels(accessToken: string, projectId: string): Promise<AntigravityModelEntry[]> {
  const json = await postCloudCode(accessToken, 'fetchAvailableModels', { project: projectId });
  const entries = parseAntigravityModels(json);
  if (!entries.length) {
    // Loud in Metro so a catalog-shape change is visible from the phone.
    console.warn('[antigravity] fetchAvailableModels parsed no entries; top-level keys:', Object.keys(json ?? {}).join(','));
  }
  return entries;
}

/** Pooled quota summary (Gemini vs Claude & GPT, each with 5-hour and weekly windows). */
export async function fetchAntigravityQuotaSummary(accessToken: string, projectId: string): Promise<any> {
  return postCloudCode(accessToken, 'retrieveUserQuotaSummary', { project: projectId });
}

/** Per-model quota buckets; the fallback when the summary endpoint is unavailable. */
export async function fetchAntigravityQuota(accessToken: string, projectId: string): Promise<any> {
  return postCloudCode(accessToken, 'retrieveUserQuota', { project: projectId });
}
