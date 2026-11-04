// Best-effort SSO usage forwarding. A failure here must never affect a page or
// a business request.
const MAX_TITLE = 160;

export function createSsoTelemetry(config, { fetchImpl = globalThis.fetch } = {}) {
  const enabled = Boolean(config?.configured && config.clientId && config.clientSecret && config.baseUrl);
  const auth = enabled
    ? 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64')
    : '';

  async function forward({ kind, ssoUserId, sessionId, pagePath = null, title = null } = {}) {
    if (!enabled || !ssoUserId || !sessionId) return false;
    if (!['session_start', 'page_view', 'heartbeat', 'session_end'].includes(kind)) return false;
    const event = { kind, sso_user_id: String(ssoUserId), session_id: String(sessionId) };
    if (pagePath) event.page_path = String(pagePath).slice(0, 500);
    if (title) event.title = String(title).slice(0, MAX_TITLE);
    try {
      const res = await fetchImpl(`${config.baseUrl}/api/telemetry/events`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [event] }),
        signal: AbortSignal.timeout(3_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  return { enabled, forward };
}
