import type { CompletionParams, TokenData } from 'llama.rn';
import { abortError, setActivity, withContext } from '../local/runtime';
import { uid } from '../storage';
import { contextFor, useLocalModels } from '@/store/localModels';
import type { ProviderAdapter, StreamUsage, ToolCall, WireMessage } from './types';

/** Runs downloaded GGUF models on the phone through llama.cpp, with OpenAI-style messages. */

/** Room kept for the reply when checking that a prompt fits the context. */
const REPLY_RESERVE = 512;
// How much of the end of the text streamed so far a partial result is checked against before its
// new text is taken as an addition to it.
const EMIT_CHECK = 256;

export const local: ProviderAdapter = {
  async listModels() {
    const { models } = useLocalModels.getState();
    return { models: models.map((m) => ({ id: m.id, efforts: m.efforts, contextLength: contextFor(m) })) };
  },

  stream({ model, messages, system, effort, tools, signal, onToken, onReasoning, onToolDraft }) {
    return withContext(model, signal, async ({ context, nCtx, vision }) => {
      const chat: LlamaMessage[] = [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages.flatMap((m) => toLlama(m, vision)),
      ];
      const toolList = tools?.length
        ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
        : undefined;
      const params: CompletionParams = {
        messages: chat as CompletionParams['messages'],
        jinja: true,
        reasoning_format: 'auto',
        enable_thinking: effort !== 'off',
        ...(effort && effort !== 'on' && effort !== 'off' ? { chat_template_kwargs: { reasoning_effort: effort } } : {}),
        ...(toolList ? { tools: toolList, tool_choice: 'auto' } : {}),
      };

      // Counting the prompt is quick next to reading it, and tells the chat what it's waiting on.
      const formatted = await context.getFormattedChat(params.messages!, null, {
        jinja: true,
        tools: toolList,
        tool_choice: params.tool_choice,
        enable_thinking: params.enable_thinking,
        reasoning_format: 'auto',
        ...(params.chat_template_kwargs ? { chat_template_kwargs: params.chat_template_kwargs } : {}),
      });
      const { tokens } = await context.tokenize(
        formatted.prompt,
        formatted.has_media ? { media_paths: formatted.media_paths } : {}
      );
      const promptTokens = tokens.length;
      // llama.cpp would quietly cut a prompt that's over the window; saying so lets the chat compress it.
      if (promptTokens > nCtx - REPLY_RESERVE) {
        throw new Error(`The prompt is ${promptTokens} tokens, over this model's ${nCtx}-token context length.`);
      }
      // Stop at the end of the window: with context shifting a model that never ends its turn
      // would otherwise generate forever.
      params.n_predict = nCtx - promptTokens;
      if (signal.aborted) throw abortError();
      const started = Date.now();
      setActivity({ modelId: model, phase: 'prompt', tokens: promptTokens, since: started });
      let firstTokenAt = 0;

      let content = '';
      let reasoning = '';
      const ids: string[] = [];
      const emit = (next: string | undefined, prev: string, send?: (t: string) => void) => {
        // Each partial result carries the whole text so far, so comparing all of it with the last
        // one on every token grew with the reply. Its end, where the new text joins on, is checked.
        const from = Math.max(0, prev.length - EMIT_CHECK);
        if (typeof next !== 'string' || next.length <= prev.length || !next.startsWith(from ? prev.slice(from) : prev, from)) return prev;
        send?.(next.slice(prev.length));
        return next;
      };
      const onData = (data: TokenData) => {
        if (!firstTokenAt) {
          firstTokenAt = Date.now();
          setActivity(null);
        }
        if (signal.aborted) return;
        // Partial results carry everything parsed so far, split into reasoning, text and tool calls.
        if (data.content === undefined && data.reasoning_content === undefined && !data.tool_calls) {
          content += data.token;
          if (data.token) onToken(data.token);
          return;
        }
        reasoning = emit(data.reasoning_content, reasoning, onReasoning);
        content = emit(data.content, content, onToken);
        data.tool_calls?.forEach((tc, index) => {
          if (!tc.function?.name) return;
          const id = (ids[index] ??= tc.id || `call_${uid()}`);
          onToolDraft?.({ index, id, name: tc.function.name, args: tc.function.arguments ?? '' });
        });
      };

      // Typed as a promise, but the native call can return nothing, or throw once the context is gone.
      const stop = () => {
        try {
          void Promise.resolve(context.stopCompletion()).catch(() => {});
        } catch {}
      };
      signal.addEventListener('abort', stop);
      let result;
      try {
        result = await context.completion(params, onData);
      } finally {
        signal.removeEventListener('abort', stop);
        setActivity(null);
      }
      if (signal.aborted) throw abortError();

      reasoning = emit(result.reasoning_content, reasoning, onReasoning);
      content = emit(result.content, content, onToken);
      // The chat parser found neither an answer, thoughts nor calls in what the model wrote, which
      // happens when its template isn't one llama.cpp knows: show the raw text rather than nothing.
      if (!content && !reasoning && !result.tool_calls?.length && result.text?.trim()) {
        content = result.text.trim();
        onToken(content);
      }
      if (__DEV__) {
        const t = result.timings;
        console.log(
          `[on-device] ${model}: prompt ${promptTokens} tokens (${t?.prompt_n ?? '?'} read, ${t?.cache_n ?? 0} cached) in ${
            firstTokenAt ? ((firstTokenAt - started) / 1000).toFixed(1) : '?'
          }s; ${t?.predicted_n ?? 0} tokens at ${t?.predicted_per_second?.toFixed(1) ?? '?'} t/s; stopped by ${
            result.stopped_eos ? 'end of turn' : result.stopped_word ? `stop word ${result.stopping_word}` : result.stopped_limit ? 'length limit' : result.context_full ? 'full context' : result.interrupted ? 'interrupt' : 'unknown'
          }; answer ${content.length} chars, thoughts ${reasoning.length} chars, ${result.tool_calls?.length ?? 0} tool calls` +
            (!content && !result.tool_calls?.length ? `
raw output: ${JSON.stringify(result.text.slice(0, 400))}` : '')
        );
      }
      const toolCalls: ToolCall[] = (result.tool_calls ?? [])
        .filter((tc) => tc.function?.name)
        .map((tc, index) => ({
          id: ids[index] ?? tc.id ?? `call_${uid()}`,
          name: tc.function.name,
          input: parseArgs(tc.function.arguments),
        }));
      const t = result.timings;
      const usage: StreamUsage | undefined = t
        ? {
            output: t.predicted_n,
            decodeMs: t.predicted_ms,
            input: (t.prompt_n ?? 0) + (t.cache_n ?? 0),
            cached: t.cache_n,
          }
        : undefined;
      return { toolCalls, usage };
    });
  },
};

function parseArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {};
  try {
    const value = JSON.parse(args);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { value };
  } catch {
    return { _raw: args };
  }
}

const imageParts = (images: WireMessage['images']) =>
  images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } }));

const NO_VISION = '[An image was attached here, but this model can’t see images.]';

function withImages(role: string, text: string, images: WireMessage['images'], vision: boolean): LlamaMessage {
  if (!images.length) return { role, content: text };
  if (!vision) return { role, content: [text, ...images.map(() => NO_VISION)].filter(Boolean).join('\n\n') };
  return { role, content: [...imageParts(images), ...(text ? [{ type: 'text', text }] : [])] };
}

/** An OpenAI-style chat message; llama.cpp's chat templates read the tool fields too. */
type LlamaMessage = { role: string; content: string | object[]; [key: string]: unknown };

function toLlama(m: WireMessage, vision: boolean): LlamaMessage[] {
  if (m.role === 'tool') {
    const results = m.results ?? [];
    const images = results.flatMap((r) => r.images ?? []);
    return [
      ...results.map((r) => ({ role: 'tool', tool_call_id: r.callId, name: r.name, content: r.output || '(no output)' })),
      // Tool results only take text, so images the tools returned follow as a user turn.
      ...(images.length ? [withImages('user', 'Images returned by the tool calls above:', images, vision)] : []),
    ];
  }
  if (m.toolCalls?.length) {
    return [
      {
        role: 'assistant',
        content: m.text || '',
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        })),
      },
    ];
  }
  return [withImages(m.role, m.text, m.images, vision)];
}
