import { entryAvailable } from '@/lib/tools';
import { entryOn, LOCAL_TOOL_GROUPS, WEB_TOOLS } from '@/lib/tools/catalog';

/** How many of the listed tools are on, out of those this device has. */
export function countToolsOn(disabled: string[]) {
  const entries = LOCAL_TOOL_GROUPS.flatMap((g) => g.tools).filter(entryAvailable);
  return { on: entries.filter((e) => entryOn(e, disabled)).length, total: entries.length };
}

/** One line on what the web tools can do, given the search provider's label. */
export function webDetail(provider: string, disabled: string[]) {
  const [search, fetch] = WEB_TOOLS.map((e) => entryOn(e, disabled));
  if (search && fetch) return `Search with ${provider} and read pages`;
  if (search) return `Search with ${provider}`;
  return fetch ? 'Read web pages' : 'Every web tool is turned off';
}
