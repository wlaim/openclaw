import type { GatewayBrowserClient } from "../gateway.ts";

export type ChatModelSuggestionsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  chatModelSuggestions: string[];
};

export async function loadChatModelSuggestions(state: ChatModelSuggestionsState) {
  if (!state.client || !state.connected) {
    state.chatModelSuggestions = [];
    return;
  }
  try {
    const res = await state.client.request("models.list", {});
    const models = (res as { models?: unknown[] } | null)?.models;
    if (!Array.isArray(models)) {
      state.chatModelSuggestions = [];
      return;
    }
    const ids = models
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return "";
        }
        const id = (entry as { id?: unknown }).id;
        return typeof id === "string" ? id.trim() : "";
      })
      .filter(Boolean);
    state.chatModelSuggestions = Array.from(new Set(ids)).toSorted((a, b) => a.localeCompare(b));
  } catch {
    state.chatModelSuggestions = [];
  }
}
