import type { Endpoint, ModelInfo } from './types';

export function newModels(models: string[], fetched: ModelInfo[]): ModelInfo[] {
  const seen = new Set(models);
  return fetched.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

type ModelSettings = Required<Pick<Endpoint, 'models' | 'efforts' | 'contexts'>>;

export function appendFetchedModels(current: ModelSettings, selected: ModelInfo[]): ModelSettings {
  const additions = newModels(current.models, selected);
  if (!additions.length) return current;

  return {
    models: [...current.models, ...additions.map(({ id }) => id)],
    efforts: {
      ...current.efforts,
      ...Object.fromEntries(additions.flatMap(({ id, efforts }) => (efforts?.length ? [[id, efforts]] : []))),
    },
    contexts: {
      ...current.contexts,
      ...Object.fromEntries(
        additions.flatMap(({ id, contextLength }) => (contextLength && contextLength > 0 ? [[id, contextLength]] : []))
      ),
    },
  };
}
