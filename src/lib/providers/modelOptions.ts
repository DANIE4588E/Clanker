import type { Endpoint, ModelMediaInput, ModelOptions, ProviderType, WireMessage } from './types';

export function optionsForModel(endpoint: Pick<Endpoint, 'modelOptions'>, model: string): ModelOptions | undefined {
  const options = endpoint.modelOptions;
  return options && Object.hasOwn(options, model) ? options[model] : undefined;
}

export function isOpenAINative(baseUrl: string) {
  return /^https?:\/\/api\.openai\.com(?:[/:]|$)/i.test(baseUrl.trim());
}

export function supportsVideoInput({ type, baseUrl }: Pick<Endpoint, 'type' | 'baseUrl'>) {
  return type === 'gemini' || type === 'antigravity' || (type === 'openai' && !isOpenAINative(baseUrl));
}

export function defaultMediaInputs(type: ProviderType): ModelMediaInput[] {
  // Gemini and Antigravity have historically sent video attachments as inline files.
  return type === 'gemini' || type === 'antigravity' ? ['image', 'video'] : ['image'];
}

export function modelMediaInputs(endpoint: Pick<Endpoint, 'type' | 'baseUrl'>, options?: ModelOptions) {
  const inputs = options?.mediaInputs ?? defaultMediaInputs(endpoint.type);
  return { image: inputs.includes('image'), video: supportsVideoInput(endpoint) && inputs.includes('video') };
}

export function modelEffortValue(options: ModelOptions | undefined, level: string | undefined) {
  if (!level || options?.reasoningDisabled) return undefined;
  const values = options?.effortValues;
  return values && Object.hasOwn(values, level) ? values[level] : level;
}

export function filterModelInputs(messages: WireMessage[], { image, video }: ReturnType<typeof modelMediaInputs>) {
  if (image && video) return messages;
  return messages.map((message) => {
    const files = message.files;
    const hasVideo = !video && files?.some((file) => file.mimeType.startsWith('video/'));
    const hasImages = !image && message.images.length;
    const hasResultImages = !image && message.results?.some((result) => result.images?.length);
    if (!hasVideo && !hasImages && !hasResultImages) return message;
    return {
      ...message,
      ...(hasVideo ? { files: files?.filter((file) => !file.mimeType.startsWith('video/')) } : {}),
      ...(hasImages ? { images: [] } : {}),
      ...(hasResultImages ? { results: message.results?.map((result) => ({ ...result, images: [] })) } : {}),
    };
  });
}

export function selectModelEntries<T>(models: string[], entries: Record<string, T> | undefined): Record<string, T> {
  if (!entries) return {};
  return Object.fromEntries(models.filter((model) => Object.hasOwn(entries, model)).map((model) => [model, entries[model]]));
}
