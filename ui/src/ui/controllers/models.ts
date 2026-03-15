import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelCatalogEntry } from "../types.ts";

export type ChatModelSuggestionsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  chatModelSuggestions: string[];
};

export async function loadModels(
  client: GatewayBrowserClient | null,
): Promise<ModelCatalogEntry[]> {
  if (!client) {
    return [];
  }
  try {
    const res = await client.request("models.list", {});
    const models = (res as { models?: unknown[] } | null)?.models;
    if (!Array.isArray(models)) {
      return [];
    }
    return models
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const rec = entry as Record<string, unknown>;
        const id = typeof rec.id === "string" ? rec.id.trim() : "";
        const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;
        const provider = typeof rec.provider === "string" ? rec.provider.trim() : "";
        if (!id || !provider) {
          return null;
        }
        return {
          id,
          name,
          provider,
          contextWindow: typeof rec.contextWindow === "number" ? rec.contextWindow : undefined,
          reasoning: typeof rec.reasoning === "boolean" ? rec.reasoning : undefined,
          input: Array.isArray(rec.input)
            ? rec.input.filter(
                (item): item is "text" | "image" => item === "text" || item === "image",
              )
            : undefined,
        } satisfies ModelCatalogEntry;
      })
      .filter((entry): entry is ModelCatalogEntry => Boolean(entry));
  } catch {
    return [];
  }
}

export async function loadChatModelSuggestions(state: ChatModelSuggestionsState) {
  if (!state.client || !state.connected) {
    state.chatModelSuggestions = [];
    return;
  }
  try {
    const ids = (await loadModels(state.client)).map((entry) => entry.id).filter(Boolean);
    state.chatModelSuggestions = Array.from(new Set(ids)).toSorted((a, b) => a.localeCompare(b));
  } catch {
    state.chatModelSuggestions = [];
  }
}
