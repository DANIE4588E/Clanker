import type { Endpoint } from '@/lib/providers';
import { contextFor, LOCAL_ENDPOINT_ID, useLocalModels } from '@/store/localModels';
import { useSettings } from '@/store/settings';

/**
 * Keeps the On-device entry in the endpoint list in step with the downloaded models. Lives apart
 * from both stores so neither imports the other (settings → providers → the local adapter →
 * the model store would otherwise loop back to settings).
 */
export function syncLocalEndpoint() {
  const { models } = useLocalModels.getState();
  const settings = useSettings.getState();
  const existing = settings.endpoints.find((e) => e.id === LOCAL_ENDPOINT_ID);
  if (!models.length) {
    if (existing) settings.removeEndpoint(LOCAL_ENDPOINT_ID);
    return;
  }
  const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
  const ids = sorted.map((m) => m.id);
  const endpoint: Endpoint = {
    id: LOCAL_ENDPOINT_ID,
    name: 'On-device',
    type: 'local',
    baseUrl: 'local://',
    models: ids,
    efforts: Object.fromEntries(sorted.flatMap((m) => (m.efforts?.length ? [[m.id, m.efforts]] : []))),
    contexts: Object.fromEntries(sorted.map((m) => [m.id, contextFor(m)])),
    budgets: Object.fromEntries(Object.entries(existing?.budgets ?? {}).filter(([id]) => ids.includes(id))),
  };
  settings.upsertEndpoint(endpoint);
}

// Both stores hydrate synchronously from disk, so only later changes need syncing.
useLocalModels.subscribe((state, prev) => {
  if (state.models !== prev.models) syncLocalEndpoint();
});
