/**
 * cfapi.js — Worker 自服务开通租户域名（Cloudflare Custom Domains API）
 *
 * 需要：Secret CF_API_TOKEN（权限：Account → Workers Scripts → Edit；
 * 区域资源包含部署主域所在 zone）+ 变量 CF_ACCOUNT_ID / WORKER_NAME。
 * 未配置（占位符/缺省）时 provisionDomain 返回 { state: "disabled" }，
 * 调用方降级为「跑 deploy.sh 开通」。
 */

const CF_API = "https://api.cloudflare.com/client/v4";

function domainApiConfigured(env) {
  return Boolean(
    env.CF_API_TOKEN &&
    env.CF_ACCOUNT_ID &&
    env.WORKER_NAME &&
    !String(env.CF_ACCOUNT_ID).startsWith("PLACEHOLDER"),
  );
}

async function cfApi(env, path, opts = {}) {
  const res = await fetch(CF_API + path, {
    method: opts.method || "GET",
    headers: {
      Authorization: "Bearer " + env.CF_API_TOKEN,
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** 把 <hostname> 挂到本 Worker：幂等。返回 {state, detail?} */
export async function provisionDomain(env, hostname) {
  if (!domainApiConfigured(env)) return { state: "disabled" };
  const acct = env.CF_ACCOUNT_ID;

  // 已存在（不论挂在谁名下）→ 已挂在本 Worker 名下算成功，挂别人名下要报错
  const q = `?hostname=${encodeURIComponent(hostname)}&per_page=50`;
  const list = await cfApi(env, `/accounts/${acct}/workers/domains${q}`);
  if (!list.ok) {
    const msg = list.data?.errors?.[0]?.message || `HTTP ${list.status}`;
    return { state: "error", detail: `查询域名失败：${msg}（检查 Token 权限：Workers Scripts Edit）` };
  }
  const hits = list.data?.result || [];
  if (hits.length > 0) {
    if (hits.some((d) => d.service === env.WORKER_NAME)) return { state: "already" };
    return { state: "error", detail: `域名已被其他 Worker（${hits[0].service}）占用` };
  }

  const zoneName = String(env.SSO_BASE_DOMAIN).split(".").slice(1).join(".");
  const attach = await cfApi(env, `/accounts/${acct}/workers/domains`, {
    method: "PUT",
    body: { zone_name: zoneName, hostname, service: env.WORKER_NAME, enabled: true },
  });
  if (!attach.ok) {
    const msg = attach.data?.errors?.[0]?.message || `HTTP ${attach.status}`;
    return { state: "error", detail: `注册失败：${msg}` };
  }
  return { state: "created" };
}

/** 摘掉租户域名（下线用）。返回 {state, detail?} */
export async function detachDomain(env, hostname) {
  if (!domainApiConfigured(env)) return { state: "disabled" };
  const acct = env.CF_ACCOUNT_ID;
  const q = `?hostname=${encodeURIComponent(hostname)}&per_page=50`;
  const list = await cfApi(env, `/accounts/${acct}/workers/domains${q}`);
  if (!list.ok) {
    const msg = list.data?.errors?.[0]?.message || `HTTP ${list.status}`;
    return { state: "error", detail: `查询域名失败：${msg}` };
  }
  const mine = (list.data?.result || []).filter((d) => d.service === env.WORKER_NAME);
  if (mine.length === 0) return { state: "already" };
  for (const d of mine) {
    const del = await cfApi(env, `/accounts/${acct}/workers/domains/${d.id}`, { method: "DELETE" });
    if (!del.ok) {
      const msg = del.data?.errors?.[0]?.message || `HTTP ${del.status}`;
      return { state: "error", detail: `删除失败：${msg}` };
    }
  }
  return { state: "detached" };
}
