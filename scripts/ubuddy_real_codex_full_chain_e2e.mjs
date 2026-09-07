process.env.JANUS_REAL_CODEX_E2E = '1';
process.env.JANUS_UBUDDY_REAL_E2E_SCOPE = 'core';

await import('./ubuddy_full_chain_e2e.mjs');
