// Deployment config for the Area Caller frontend.
//
// It points at the SAME deployed Worker as route-caller: one Worker, one D1,
// two frontends. The area endpoints live under /api/areas and share nothing
// with the route tables.
//
// Leave apiBase empty and the UI runs in preview mode with clearly-labelled
// sample data. No API keys ever belong in this file — the Google key is a
// Worker secret.
window.AREA_CALLER_CONFIG = {
  apiBase: 'https://route-caller-api.micaiah-tasks.workers.dev',
};
