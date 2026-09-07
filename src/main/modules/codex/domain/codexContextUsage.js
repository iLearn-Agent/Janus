// Keep this calculation aligned with Codex CLI's
// TokenUsage::percent_of_context_window_remaining implementation.
// Source (v0.144.3):
// https://github.com/openai/codex/blob/rust-v0.144.3/codex-rs/protocol/src/protocol.rs
export const CODEX_CONTEXT_BASELINE_TOKENS = 12_000;

export function codexContextRemainingPercent(lastTotalTokens = 0, modelContextWindow = 0) {
  const contextWindow = Math.max(0, Math.floor(Number(modelContextWindow) || 0));
  if (contextWindow <= CODEX_CONTEXT_BASELINE_TOKENS) return 0;

  const effectiveWindow = contextWindow - CODEX_CONTEXT_BASELINE_TOKENS;
  const tokensInContextWindow = Math.max(0, Math.floor(Number(lastTotalTokens) || 0));
  const used = Math.max(0, tokensInContextWindow - CODEX_CONTEXT_BASELINE_TOKENS);
  const remaining = Math.max(0, effectiveWindow - used);
  return Math.max(0, Math.min(100, Math.round((remaining / effectiveWindow) * 100)));
}
