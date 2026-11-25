import { useEffect, useState } from 'react';
import { formatTokens } from '@/lib/context';
import { useActivityOf } from './runtime';

/**
 * What a reply from an on-device model is waiting on before its first token, for the pill that
 * would otherwise just say "Thinking…": the model loading, or the prompt being read, with the
 * seconds it has taken so far. Undefined when there's nothing to say.
 */
export function useActivityLabel(modelId: string | undefined) {
  const activity = useActivityOf(modelId);
  const since = activity?.phase === 'prompt' ? activity.since : null;
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (since == null) return;
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 1000);
    tick();
    return () => clearInterval(timer);
  }, [since]);

  if (!activity) return undefined;
  if (activity.phase === 'loading') return `Loading model… ${activity.progress}%`;
  const seconds = since != null && now > since ? Math.floor((now - since) / 1000) : 0;
  return `Reading prompt · ${formatTokens(activity.tokens)} tokens${seconds ? ` · ${seconds}s` : ''}`;
}
