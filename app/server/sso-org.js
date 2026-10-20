// 钉钉组织架构：不直连钉钉，改从统一登录服务（marius-sso）读取
//
// SSO 里已经缓存了钉钉通讯录（/org/*），AppKey/AppSecret 只存在 SSO 一处。
// 本项目只用 SSO 的 client 凭证取数据，不再需要 DINGTALK_APP_KEY。
import { readSsoConfig } from './sso-auth.js';

const PAGE_SIZE = 200;
const MAX_MEMBERS = 5000;
const TIMEOUT_MS = 15_000;

let configCache = null;

function ssoConfig() {
  if (!configCache) {
    try {
      configCache = readSsoConfig();
    } catch (err) {
      configCache = { configured: false, baseUrl: '', clientId: '', clientSecret: '', error: err.message };
    }
  }
  return configCache;
}

export function ssoOrgStatus() {
  const cfg = ssoConfig();
  return {
    configured: Boolean(cfg.configured && cfg.baseUrl),
    baseUrl: cfg.baseUrl || null,
    clientId: cfg.configured && cfg.clientId ? `${cfg.clientId.slice(0, 8)}****` : null,
    error: cfg.error || null,
  };
}

async function ssoGet(pathname) {
  const cfg = ssoConfig();
  if (!cfg.configured) throw new Error('统一登录服务未配置 client_id / client_secret');
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  let response;
  try {
    response = await fetch(`${cfg.baseUrl}${pathname}`, {
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`连接统一登录服务失败：${err.name === 'TimeoutError' ? '超时' : err.message}`);
  }
  if (!response.ok) {
    let message = `统一登录服务返回 ${response.status}`;
    try {
      const body = await response.json();
      message = body.error_description || body.error || message;
    } catch { /* 非 JSON 响应，保留状态码提示 */ }
    throw new Error(message);
  }
  return response.json();
}

// 部门列表 + 全量成员。成员分页拉取，直到取满 total 或接口不再返回数据。
export async function fetchSsoOrg() {
  const deptPayload = await ssoGet('/org/departments');
  const departments = Array.isArray(deptPayload.departments) ? deptPayload.departments : [];

  const members = [];
  let total = Infinity;
  for (let offset = 0; offset < MAX_MEMBERS && members.length < total; offset += PAGE_SIZE) {
    const page = await ssoGet(`/org/members?limit=${PAGE_SIZE}&offset=${offset}`);
    const items = Array.isArray(page.items) ? page.items : [];
    total = Number.isFinite(Number(page.total)) ? Number(page.total) : members.length + items.length;
    members.push(...items);
    if (!items.length) break;
  }

  return {
    departments,
    members,
    syncedAt: deptPayload.synced_at ?? null,
    truncated: members.length < total,
  };
}
