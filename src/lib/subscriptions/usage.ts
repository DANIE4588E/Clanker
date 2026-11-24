/** A single rate-limit or quota window for a subscription, expressed as usage remaining. */
export type UsageWindow = {
  id: string;
  label: string;
  /** Remaining allowance as a percentage (0–100). */
  remainingPercent: number;
  /** Used allowance as a percentage (0–100). */
  usedPercent: number;
  /** Epoch milliseconds when this window resets, if reported. */
  resetsAt?: number;
  /** Optional extra detail (e.g. remaining request count or credit status). */
  detail?: string;
};

/** Latest known remaining-usage snapshot for a subscription endpoint. */
export type SubscriptionUsage = {
  plan?: string;
  email?: string;
  windows: UsageWindow[];
  /** Additional note such as credits balance or extra usage status. */
  extra?: string;
  fetchedAt: number;
  error?: string;
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseResetTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Unix seconds vs milliseconds.
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 1e12 ? numeric : numeric * 1000;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function windowLabelFromSeconds(seconds: unknown, fallback: string): string {
  const s = typeof seconds === 'number' ? seconds : Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return fallback;
  if (s >= 86400 && s % 86400 === 0) {
    const days = s / 86400;
    return days === 7 ? '7-day' : `${days}-day`;
  }
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600}-hour`;
  if (s >= 60) return `${Math.round(s / 60)}-min`;
  return fallback;
}

function formatPlanName(plan: unknown): string | undefined {
  if (typeof plan !== 'string' || !plan.trim()) return undefined;
  const lower = plan.trim().toLowerCase();
  if (lower === 'plus') return 'Plus';
  if (lower === 'pro') return 'Pro';
  if (lower === 'max') return 'Max';
  if (lower === 'team') return 'Team';
  if (lower === 'enterprise') return 'Enterprise';
  if (lower === 'free') return 'Free';
  return plan.trim().replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildCodexWindow(id: string, raw: any, fallbackLabel: string, prefix?: string): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const usedRaw = typeof raw.used_percent === 'number' ? raw.used_percent : Number(raw.used_percent);
  if (!Number.isFinite(usedRaw)) return null;
  const usedPercent = clampPercent(usedRaw);
  const remainingPercent = clampPercent(100 - usedRaw);
  const baseLabel = windowLabelFromSeconds(raw.limit_window_seconds, fallbackLabel);
  const label = prefix ? `${prefix} (${baseLabel})` : baseLabel;
  const resetsAt =
    parseResetTimestamp(raw.reset_at) ??
    (typeof raw.reset_after_seconds === 'number' && Number.isFinite(raw.reset_after_seconds)
      ? Date.now() + raw.reset_after_seconds * 1000
      : undefined);
  return { id, label, remainingPercent, usedPercent, ...(resetsAt ? { resetsAt } : {}) };
}

/** Parses `GET https://chatgpt.com/backend-api/wham/usage`. */
export function parseCodexUsage(json: any, now = Date.now()): SubscriptionUsage {
  const windows: UsageWindow[] = [];
  const rl = json?.rate_limit;
  const primary = buildCodexWindow('primary', rl?.primary_window, '5-hour');
  if (primary) windows.push(primary);
  const secondary = buildCodexWindow('secondary', rl?.secondary_window, '7-day');
  if (secondary) windows.push(secondary);

  if (Array.isArray(json?.additional_rate_limits)) {
    for (const extra of json.additional_rate_limits) {
      const title = typeof extra?.title === 'string' ? extra.title : typeof extra?.id === 'string' ? extra.id : undefined;
      const w = buildCodexWindow(`extra_${extra?.id ?? windows.length}`, extra?.primary_window ?? extra?.rate_limit?.primary_window, 'Window', title);
      if (w) windows.push(w);
    }
  }

  const review = buildCodexWindow('code_review', json?.code_review_rate_limit?.primary_window, 'Code review', 'Code review');
  if (review) windows.push(review);

  let extra: string | undefined;
  const credits = json?.credits;
  if (credits && typeof credits === 'object') {
    if (credits.unlimited) extra = 'Unlimited credits';
    else if (typeof credits.balance === 'number' && Number.isFinite(credits.balance) && credits.has_credits) {
      extra = `Credits balance: ${credits.balance}`;
    } else if (credits.overage_limit_reached) {
      extra = 'Overage limit reached';
    }
  }

  return {
    plan: formatPlanName(json?.plan_type),
    email: typeof json?.email === 'string' ? json.email : undefined,
    windows,
    ...(extra ? { extra } : {}),
    fetchedAt: now,
  };
}

/** Updates Codex usage windows from `x-codex-*` response headers returned during streaming. */
export function parseCodexUsageHeaders(
  headers: { get(name: string): string | null },
  existing?: SubscriptionUsage,
  now = Date.now()
): SubscriptionUsage | null {
  const pUsed = headers.get('x-codex-primary-used-percent');
  const sUsed = headers.get('x-codex-secondary-used-percent');
  if (pUsed == null && sUsed == null) return null;

  const byId = new Map<string, UsageWindow>((existing?.windows ?? []).map((w) => [w.id, w]));

  const apply = (id: string, usedStr: string | null, winHeader: string, resetHeader: string, fallback: string) => {
    if (usedStr == null) return;
    const used = Number(usedStr);
    if (!Number.isFinite(used)) return;
    const prev = byId.get(id);
    const winMin = Number(headers.get(winHeader));
    const resetSec = Number(headers.get(resetHeader));
    const label = Number.isFinite(winMin) && winMin > 0 ? windowLabelFromSeconds(winMin * 60, fallback) : prev?.label ?? fallback;
    const resetsAt = Number.isFinite(resetSec) && resetSec > 0 ? now + resetSec * 1000 : prev?.resetsAt;
    byId.set(id, {
      id,
      label,
      usedPercent: clampPercent(used),
      remainingPercent: clampPercent(100 - used),
      ...(resetsAt ? { resetsAt } : {}),
    });
  };

  apply('primary', pUsed, 'x-codex-primary-window-minutes', 'x-codex-primary-reset-after-seconds', '5-hour');
  apply('secondary', sUsed, 'x-codex-secondary-window-minutes', 'x-codex-secondary-reset-after-seconds', '7-day');

  return {
    ...existing,
    windows: [...byId.values()],
    fetchedAt: now,
    error: undefined,
  };
}

function buildClaudeWindow(id: string, label: string, raw: any): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const utilRaw = typeof raw.utilization === 'number' ? raw.utilization : Number(raw.utilization);
  if (!Number.isFinite(utilRaw)) return null;
  // `/api/oauth/usage` reports 0..100; headers sometimes report 0..1.
  const usedRaw = utilRaw <= 1 && utilRaw > 0 && raw._fraction ? utilRaw * 100 : utilRaw;
  const resetsAt = parseResetTimestamp(raw.resets_at ?? raw.reset);
  return {
    id,
    label,
    usedPercent: clampPercent(usedRaw),
    remainingPercent: clampPercent(100 - usedRaw),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/** Parses `GET https://api.anthropic.com/api/oauth/usage`. */
export function parseClaudeUsage(json: any, now = Date.now()): SubscriptionUsage {
  const windows: UsageWindow[] = [];
  const entries: [string, string, unknown][] = [
    ['five_hour', '5-hour', json?.five_hour],
    ['seven_day', '7-day', json?.seven_day],
    ['seven_day_sonnet', 'Sonnet (7-day)', json?.seven_day_sonnet],
    ['seven_day_opus', 'Opus (7-day)', json?.seven_day_opus],
  ];
  for (const [id, label, raw] of entries) {
    const w = buildClaudeWindow(id, label, raw);
    if (w) windows.push(w);
  }

  let extra: string | undefined;
  const ex = json?.extra_usage;
  if (ex && typeof ex === 'object' && ex.is_enabled) {
    if (typeof ex.utilization === 'number' && Number.isFinite(ex.utilization)) {
      extra = `Extra usage: ${clampPercent(100 - ex.utilization)}% left`;
    } else if (typeof ex.used_credits === 'number' && typeof ex.monthly_limit === 'number' && ex.monthly_limit > 0) {
      const left = Math.max(0, ex.monthly_limit - ex.used_credits);
      extra = `Extra usage: ${(left / 100).toFixed(2)} left`;
    } else {
      extra = 'Extra usage enabled';
    }
  }

  return {
    plan: formatPlanName(json?.plan_type ?? json?.subscription_type),
    windows,
    ...(extra ? { extra } : {}),
    fetchedAt: now,
  };
}

/** Updates Claude usage windows from `anthropic-ratelimit-unified-*` streaming response headers. */
export function parseClaudeUsageHeaders(
  headers: { get(name: string): string | null },
  existing?: SubscriptionUsage,
  now = Date.now()
): SubscriptionUsage | null {
  const u5 = headers.get('anthropic-ratelimit-unified-5h-utilization');
  const u7 = headers.get('anthropic-ratelimit-unified-7d-utilization');
  if (u5 == null && u7 == null) return null;

  const byId = new Map<string, UsageWindow>((existing?.windows ?? []).map((w) => [w.id, w]));

  const apply = (id: string, label: string, utilStr: string | null, resetStr: string | null) => {
    if (utilStr == null) return;
    const raw = Number(utilStr);
    if (!Number.isFinite(raw)) return;
    // Anthropic unified headers report utilization as a 0..1 fraction (e.g. 0.37).
    const used = raw <= 1 ? raw * 100 : raw;
    const resetsAt = parseResetTimestamp(resetStr) ?? byId.get(id)?.resetsAt;
    byId.set(id, {
      id,
      label,
      usedPercent: clampPercent(used),
      remainingPercent: clampPercent(100 - used),
      ...(resetsAt ? { resetsAt } : {}),
    });
  };

  apply('five_hour', '5-hour', u5, headers.get('anthropic-ratelimit-unified-5h-reset'));
  apply('seven_day', '7-day', u7, headers.get('anthropic-ratelimit-unified-7d-reset'));

  return {
    ...existing,
    windows: [...byId.values()],
    fetchedAt: now,
    error: undefined,
  };
}

/** Formats a reset epoch timestamp as a concise relative countdown, e.g. "in 2h 15m" or "in 3d 4h". */
export function formatResetTime(resetsAt: number, now = Date.now()): string {
  const diffMs = resetsAt - now;
  if (diffMs <= 30_000) return 'soon';
  const totalMin = Math.ceil(diffMs / 60_000);
  if (totalMin < 60) return `in ${totalMin}m`;
  const totalHours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (totalHours < 24) return mins > 0 ? `in ${totalHours}h ${mins}m` : `in ${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
}

/** Picks the headline remaining percentage for a compact badge (e.g. ChatHeader). */
export function headlineWindow(usage: SubscriptionUsage | undefined, _model?: string): UsageWindow | undefined {
  if (!usage?.windows.length) return undefined;
  return usage.windows[0];
}

/** One-line summary of remaining subscription usage for Settings rows and subtitles. */
export function compactUsageSummary(usage: SubscriptionUsage | undefined, _model?: string): string | undefined {
  if (!usage?.windows.length) return undefined;
  return usage.windows
    .slice(0, 2)
    .map((w) => {
      const short = w.label.replace(/-hour$/i, 'h').replace(/-day$/i, 'd');
      return `${short} ${w.remainingPercent}% left`;
    })
    .join(' · ');
}
