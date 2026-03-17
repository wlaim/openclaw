import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";

function formatUpdatedAt(updatedAt: number | null | undefined): string {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    return "Unknown activity";
  }
  try {
    return new Date(updatedAt).toLocaleString();
  } catch {
    return "Unknown activity";
  }
}

function formatContextSize(candidate: AppViewState["bindRecoveryCandidates"][number]): string {
  const total = typeof candidate.totalTokens === "number" ? candidate.totalTokens : null;
  const context = typeof candidate.contextTokens === "number" ? candidate.contextTokens : null;
  if (total != null && context != null) {
    return `${total} / ${context} tokens`;
  }
  if (total != null) {
    return `${total} tokens`;
  }
  if (context != null) {
    return `${context} ctx`;
  }
  return "Unknown size";
}

export function renderBindRecovery(state: AppViewState) {
  if (!state.bindRecoveryOpen) {
    return nothing;
  }
  const selected = state.bindRecoveryCandidates.find(
    (candidate) => candidate.key === state.bindRecoverySelectedCandidateKey,
  );
  const candidateCount = state.bindRecoveryCandidates.length;
  return html`
    <div class="exec-approval-overlay" role="dialog" aria-modal="true" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">Main session drift recovery</div>
            <div class="exec-approval-sub">Bind canonical main back to the right session.</div>
          </div>
        </div>

        ${
          state.bindRecoveryError
            ? html`<div class="exec-approval-error">${state.bindRecoveryError}</div>`
            : nothing
        }

        ${
          selected
            ? html`
                <div class="exec-approval-command mono">
                  ${state.bindRecoveryCanonicalMainKey} → ${selected.key}
                </div>
                <div class="exec-approval-meta">
                  <div class="exec-approval-meta-row">
                    <span>Candidate</span>
                    <span>${selected.label}</span>
                  </div>
                  <div class="exec-approval-meta-row">
                    <span>Last activity</span>
                    <span>${formatUpdatedAt(selected.updatedAt)}</span>
                  </div>
                  <div class="exec-approval-meta-row">
                    <span>Context size</span>
                    <span>${formatContextSize(selected)}</span>
                  </div>
                  ${
                    selected.lastMessagePreview
                      ? html`<div class="exec-approval-meta-row">
                        <span>Preview</span>
                        <span>${selected.lastMessagePreview}</span>
                      </div>`
                      : nothing
                  }
                  <div class="exec-approval-meta-row">
                    <span>Safety</span>
                    <span>Creates sessions.json backup. No transcript deletion.</span>
                  </div>
                </div>
                <div class="exec-approval-actions">
                  <button
                    class="btn"
                    ?disabled=${state.bindRecoverySubmitting}
                    @click=${() => state.selectBindRecoveryCandidate(null)}
                  >
                    Back
                  </button>
                  <button
                    class="btn primary"
                    ?disabled=${state.bindRecoverySubmitting}
                    @click=${() => void state.confirmBindRecovery()}
                  >
                    ${state.bindRecoverySubmitting ? "Binding…" : "Confirm bind"}
                  </button>
                </div>
              `
            : html`
                <div class="exec-approval-command mono">
                  ${
                    candidateCount > 0
                      ? `Found ${candidateCount} main-like drift candidate${candidateCount === 1 ? "" : "s"}`
                      : "No main-like drift candidates found"
                  }
                </div>
                <div class="exec-approval-meta">
                  <div class="exec-approval-meta-row">
                    <span>Canonical main</span>
                    <span>${state.bindRecoveryCanonicalMainKey}</span>
                  </div>
                  ${
                    state.bindRecoveryCurrentSessionId
                      ? html`<div class="exec-approval-meta-row">
                        <span>Current sessionId</span>
                        <span>${state.bindRecoveryCurrentSessionId}</span>
                      </div>`
                      : nothing
                  }
                </div>
                ${
                  candidateCount > 0
                    ? html`<div class="session-list bind-recovery-list">
                        ${state.bindRecoveryCandidates.map(
                          (candidate) => html`
                            <button
                              type="button"
                              class="session-row bind-recovery-row"
                              @click=${() => state.selectBindRecoveryCandidate(candidate.key)}
                            >
                              <div class="session-main">
                                <div class="session-title-row">
                                  <span class="session-title">${candidate.label}${candidate.isCurrentSession ? " · current" : ""}</span>
                                </div>
                                <div class="session-subtitle mono">${candidate.key}</div>
                                <div class="session-meta">${formatContextSize(candidate)}</div>
                                ${
                                  candidate.lastMessagePreview
                                    ? html`<div class="session-meta">${candidate.lastMessagePreview}</div>`
                                    : nothing
                                }
                              </div>
                              <div class="session-stats">${formatUpdatedAt(candidate.updatedAt)}</div>
                            </button>
                          `,
                        )}
                      </div>`
                    : html`
                        <div class="muted">Nothing looks like an unbound main-session candidate right now.</div>
                      `
                }
                <div class="exec-approval-actions">
                  <button class="btn" ?disabled=${state.bindRecoverySubmitting} @click=${state.closeBindRecovery}>
                    Close
                  </button>
                </div>
              `
        }
      </div>
    </div>
  `;
}
