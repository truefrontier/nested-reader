import type { Auth, ModelSlot, Provider, Settings } from "../platform";

/** Which account mode applies to a provider (only OpenAI and Anthropic have a plan option). */
export function authFor(settings: Pick<Settings, "auth">, provider: Provider): Auth | undefined {
  return provider === "openai" || provider === "anthropic" ? settings.auth[provider] : undefined;
}

/** The settings slot that remembers the model for a provider in a given account mode. */
export function modelSlot(provider: Provider, auth: Auth | undefined): ModelSlot {
  if (auth === "subscription" && (provider === "openai" || provider === "anthropic")) return `${provider}-subscription`;
  return provider;
}

/** OpenAI lists everything it serves; these are not chat models or are dated snapshots. */
const NOT_CHAT = /(audio|realtime|tts|transcribe|whisper|embedding|moderation|search|image|dall-e|sora|instruct|batch|-\d{4}-\d{2}-\d{2}$)/i;

/** The models worth offering in the picker, in display order. Plan lists are short aliases and pass through. */
export function chatModels(provider: Provider, auth: Auth | undefined, list: string[]): string[] {
  if (auth === "subscription") return list;
  if (provider === "openai") return list.filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m) && !NOT_CHAT.test(m)).sort();
  if (provider === "anthropic") return list.filter((m) => m.startsWith("claude"));
  return list;
}

/** Name fragments that mark a provider's fastest, cheapest tier, most preferred first. */
const CHEAP: Partial<Record<Provider, RegExp[]>> = {
  openai: [/luna/i, /nano/i, /mini/i],
  anthropic: [/haiku/i],
  custom: [/luna/i, /nano/i, /mini/i, /haiku/i, /flash/i, /small/i],
};

/**
 * The model to start with: the cheapest tier we recognise, else the first listed.
 * Ollama lists arrive smallest-first, so its first entry is already the fastest.
 */
export function pickDefaultModel(provider: Provider, auth: Auth | undefined, list: string[]): string | undefined {
  const usable = chatModels(provider, auth, list);
  for (const re of CHEAP[provider] ?? []) {
    const hit = usable.find((m) => re.test(m));
    if (hit) return hit;
  }
  return usable[0];
}
