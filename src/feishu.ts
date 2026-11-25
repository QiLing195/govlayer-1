/**
 * 飞书开放平台数据源连接器（Feishu / Lark Open API）：
 *   - 凭证仅从服务端环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET 读取，绝不暴露给前端；
 *   - 严格校验 FEISHU_DOMAIN 白名单（仅允许 open.feishu.cn / open.larksuite.com），防止 SSRF；
 *   - 支持真实同步飞书知识空间（Wiki + Docx 原文）、多维表格（Bitable）和组织部门（Contact）；
 *   - 支持解析含 [L0]/[L1]/[L2] 分层标记的飞书文档为 GovLayer 字段级隔离语料。
 */

import fs from "node:fs";
import path from "node:path";
import type { KnowledgeObject, ProbeRule } from "./governance.ts";

const ALLOWED_FEISHU_ORIGINS = new Set([
  "https://open.feishu.cn",
  "https://open.larksuite.com",
]);

const DATASET_SLUG_RE = /^[a-z0-9_-]{1,48}$/i;
const MAX_SYNC_NODES = 40;

export interface FeishuStatus {
  configured: boolean;
  domain: string;
  default_space_id: string;
  app_id_masked: string;
}

export interface FeishuWikiSpace {
  space_id: string;
  name: string;
  description: string;
  visibility?: string;
}

export interface FeishuDepartment {
  department_id: string;
  name: string;
}

export interface SyncedDatasetPayload {
  dataset: string;
  name: string;
  description: string;
  objects: KnowledgeObject[];
  roles: Record<string, number>;
  permission_model: {
    authority: string;
    source: string;
    principle: string;
    warning: string;
    may_claim_verified: boolean;
  };
  probe_rules: ProbeRule[];
  precedent_cases: [];
  feishu_meta: {
    source_type: "feishu_wiki" | "feishu_bitable" | "feishu_doc";
    space_id?: string;
    app_token?: string;
    table_id?: string;
    synced_at: string;
    node_count: number;
  };
}

function getFeishuOrigin(): string {
  const raw = (process.env.FEISHU_DOMAIN ?? "https://open.feishu.cn").trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(raw);
    if (ALLOWED_FEISHU_ORIGINS.has(parsed.origin)) {
      return parsed.origin;
    }
  } catch {
    // Fall back to default official origin
  }
  return "https://open.feishu.cn";
}

function maskAppId(appId: string): string {
  if (!appId) return "";
  if (appId.length <= 8) return `${appId.slice(0, 2)}****`;
  return `${appId.slice(0, 6)}****${appId.slice(-3)}`;
}

export function getFeishuStatus(): FeishuStatus {
  const appId = (process.env.FEISHU_APP_ID ?? "").trim();
  const appSecret = (process.env.FEISHU_APP_SECRET ?? "").trim();
  return {
    configured: Boolean(appId && appSecret),
    domain: getFeishuOrigin(),
    default_space_id: (process.env.FEISHU_WIKI_SPACE_ID ?? "").trim(),
    app_id_masked: maskAppId(appId),
  };
}

let cachedTenantToken: { token: string; expiresAt: number } | null = null;

async function getTenantAccessToken(): Promise<string> {
  const appId = (process.env.FEISHU_APP_ID ?? "").trim();
  const appSecret = (process.env.FEISHU_APP_SECRET ?? "").trim();
  if (!appId || !appSecret) {
    throw new Error(
      "服务端未配置 FEISHU_APP_ID / FEISHU_APP_SECRET，请在环境变量中设置飞书自建应用凭证"
    );
  }

  const now = Date.now();
  if (cachedTenantToken && cachedTenantToken.expiresAt > now + 300_000) {
    return cachedTenantToken.token;
  }

  const origin = getFeishuOrigin();
  const resp = await fetch(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    throw new Error(`飞书鉴权请求失败（HTTP ${resp.status}）`);
  }

  const data = (await resp.json()) as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`飞书获取 tenant_access_token 失败：${data.msg ?? `code=${data.code}`}`);
  }

  const ttlMs = Math.max(60, Number(data.expire ?? 7200)) * 1000;
  cachedTenantToken = {
    token: data.tenant_access_token,
    expiresAt: now + ttlMs,
  };
  return cachedTenantToken.token;
}

async function feishuGet<T>(apiPath: string): Promise<T> {
  const token = await getTenantAccessToken();
  const origin = getFeishuOrigin();
  const resp = await fetch(`${origin}${apiPath}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    throw new Error(`飞书接口调用失败（HTTP ${resp.status}）`);
  }
  const json = (await resp.json()) as { code?: number; msg?: string; data?: T };
  if (json.code !== 0) {
    throw new Error(`飞书接口返回错误：${json.msg ?? `code=${json.code}`}`);
  }
  return (json.data ?? {}) as T;
}

export async function listFeishuWikiSpaces(): Promise<FeishuWikiSpace[]> {
  const data = await feishuGet<{
    items?: Array<{
      space_id?: string;
      name?: string;
      description?: string;
      visibility?: string;
    }>;
  }>("/open-apis/wiki/v2/spaces?page_size=30");

  return (data.items ?? [])
    .filter((s) => Boolean(s.space_id))
    .map((s) => ({
      space_id: String(s.space_id),
      name: String(s.name ?? s.space_id),
      description: String(s.description ?? ""),
      visibility: s.visibility,
    }));
}

export async function listFeishuDepartments(): Promise<FeishuDepartment[]> {
  const data = await feishuGet<{
    items?: Array<{
      open_department_id?: string;
      department_id?: string;
      name?: string;
    }>;
  }>("/open-apis/contact/v3/departments?page_size=50&fetch_child=true");

  return (data.items ?? [])
    .filter((d) => Boolean(d.name))
    .map((d) => ({
      department_id: String(d.open_department_id ?? d.department_id ?? d.name),
      name: String(d.name),
    }));
}

function extractAutoKeywords(title: string, content: string): string[] {
  const kws = new Set<string>();
  const cleanTitle = title.replace(/[《》【】（）()\[\]：:，,。.\s]+/g, " ").trim();
  for (const part of cleanTitle.split(" ")) {
    if (part.length >= 2 && part.length <= 10) {
      kws.add(part);
    }
  }
  // Extract bracketed key phrases or CJK 2-4 char chunks from title
  const cjk = title.match(/[\u4e00-\u9fa5]{2,6}/g) ?? [];
  for (const token of cjk) {
    kws.add(token);
    if (token.length >= 4) {
      kws.add(token.slice(0, 2));
      kws.add(token.slice(-2));
    }
  }
  // Also scan explicit "关键词：..." lines if present
  const kwLine = content.match(/(?:关键词|关键字|keywords?)[：:]\s*([^\n]+)/i);
  if (kwLine && kwLine[1]) {
    for (const part of kwLine[1].split(/[、,，;；/\s]+/)) {
      const t = part.trim();
      if (t.length >= 2 && t.length <= 16) kws.add(t);
    }
  }
  return Array.from(kws).slice(0, 12);
}

/**
 * 解析飞书文档 / Markdown 为 GovLayer 字段级分级条款：
 *   - 按 `#` / `##` 标题拆分为独立条款；
 *   - 支持显式密级标签 `[L0]`/`[公开]`、`[L1]`/`[主管]`/`[经理]`、`[L2]`/`[HR]`/`[机密]`；
 *   - 无密级标签的正文默认归入 L0 公开层（不会凭空越权分类）。
 */
export function parseTieredMarkdownToClauses(
  markdown: string,
  defaultTitle = "飞书导入文档"
): { objects: KnowledgeObject[]; hasExplicitTiers: boolean } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: Array<{ title: string; bodyLines: string[] }> = [];
  let current: { title: string; bodyLines: string[] } | null = null;

  for (const rawLine of lines) {
    const heading = rawLine.match(/^#{1,3}\s+(.+)$/);
    if (heading && heading[1]?.trim()) {
      if (current && current.bodyLines.join("").trim()) {
        sections.push(current);
      }
      current = { title: heading[1].trim(), bodyLines: [] };
    } else {
      if (!current) {
        current = { title: defaultTitle, bodyLines: [] };
      }
      current.bodyLines.push(rawLine);
    }
  }
  if (current && current.bodyLines.join("").trim()) {
    sections.push(current);
  }

  let hasExplicitTiers = false;
  const objects: KnowledgeObject[] = [];

  sections.forEach((sec, index) => {
    const tiers: Record<string, string[]> = {};
    let activeTier = "0";

    for (const line of sec.bodyLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Skip metadata keyword lines from body text
      if (/^(?:关键词|关键字|keywords?)[：:]/i.test(trimmed)) {
        continue;
      }

      const inlineTag = trimmed.match(
        /^[\-*•\s]*(?:\[(L0|L1|L2|公开|全员|主管|经理|内部|HR|机密|审计)\]|【(L0|L1|L2|公开|全员|主管|经理|内部|HR|机密|审计)】)\s*[：:]?\s*(.*)$/i
      );
      if (inlineTag) {
        const rawTag = (inlineTag[1] ?? inlineTag[2] ?? "").toUpperCase();
        if (rawTag === "L0" || rawTag === "公开" || rawTag === "全员") {
          activeTier = "0";
        } else if (rawTag === "L1" || rawTag === "主管" || rawTag === "经理" || rawTag === "内部") {
          activeTier = "1";
          hasExplicitTiers = true;
        } else {
          activeTier = "2";
          hasExplicitTiers = true;
        }
        const rest = (inlineTag[3] ?? "").trim();
        if (rest) {
          tiers[activeTier] = tiers[activeTier] ?? [];
          tiers[activeTier].push(rest);
        }
      } else {
        tiers[activeTier] = tiers[activeTier] ?? [];
        tiers[activeTier].push(trimmed);
      }
    }

    const levels: Record<string, string> = {};
    for (const [lvl, parts] of Object.entries(tiers)) {
      const joined = parts.join("\n").trim();
      if (joined) levels[lvl] = joined;
    }
    if (Object.keys(levels).length === 0) return;

    const fullBody = sec.bodyLines.join("\n");
    objects.push({
      id: `clause-${index + 1}`,
      title: sec.title.slice(0, 80),
      keywords: extractAutoKeywords(sec.title, fullBody),
      levels,
    });
  });

  return { objects, hasExplicitTiers };
}

export async function syncFeishuWikiSpace(params: {
  spaceId: string;
  datasetId: string;
  displayName?: string;
}): Promise<SyncedDatasetPayload> {
  const spaceId = params.spaceId.trim();
  const datasetId = params.datasetId.trim().toLowerCase();
  if (!/^[a-zA-Z0-9_-]{4,64}$/.test(spaceId)) {
    throw new Error("无效的飞书知识空间 ID（space_id）");
  }
  if (!DATASET_SLUG_RE.test(datasetId)) {
    throw new Error("知识库标识仅支持字母、数字、下划线和短横线");
  }

  const nodesData = await feishuGet<{
    items?: Array<{
      node_token?: string;
      obj_token?: string;
      obj_type?: string;
      title?: string;
    }>;
  }>(`/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes?page_size=${MAX_SYNC_NODES}`);

  const nodes = (nodesData.items ?? []).slice(0, MAX_SYNC_NODES);
  if (nodes.length === 0) {
    throw new Error("该飞书知识空间下未找到可同步的文档节点，请检查应用权限（wiki:wiki:readonly）");
  }

  const objects: KnowledgeObject[] = [];
  let anyExplicitTier = false;

  for (const node of nodes) {
    if (node.obj_type !== "docx" || !node.obj_token) continue;
    const title = String(node.title ?? node.obj_token).trim();
    const rawDoc = await feishuGet<{ content?: string }>(
      `/open-apis/docx/v1/documents/${encodeURIComponent(node.obj_token)}/raw_content`
    );
    const content = String(rawDoc.content ?? "").trim();
    if (!content) continue;

    const parsed = parseTieredMarkdownToClauses(content, title);
    if (parsed.hasExplicitTiers) anyExplicitTier = true;

    if (parsed.objects.length === 1) {
      objects.push({
        ...parsed.objects[0],
        id: `feishu-${node.node_token ?? objects.length + 1}`,
        title: title.slice(0, 80),
      });
    } else {
      parsed.objects.forEach((o, i) => {
        objects.push({
          ...o,
          id: `feishu-${node.node_token ?? objects.length + 1}-${i + 1}`,
        });
      });
    }
  }

  if (objects.length === 0) {
    throw new Error("未在飞书知识空间中解析到有效 docx 文档正文（需开通 docx:document:readonly 权限）");
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const name = params.displayName?.trim() || `飞书知识空间 (${spaceId})`;

  return {
    dataset: datasetId,
    name,
    description: `同步自飞书知识空间 ${spaceId}（共 ${objects.length} 条条款）`,
    objects,
    roles: { employee: 0, manager: 1, hr: 2 },
    permission_model: {
      authority: anyExplicitTier ? "customer" : "proposed",
      source: `飞书开放平台 Wiki Space ${spaceId} 实时同步（${now}）`,
      principle: anyExplicitTier
        ? "由飞书文档内显式 [L0]/[L1]/[L2] 分层标记解析生成"
        : "飞书文档未包含显式密级标记，当前默认按 L0 公开层导入",
      warning: anyExplicitTier
        ? ""
        : "文档未声明高密级分层标记，请按需在飞书文档中添加 [L1]/[L2] 标记或通过访问权限策略设置整库准入级别",
      may_claim_verified: anyExplicitTier,
    },
    probe_rules: [],
    precedent_cases: [],
    feishu_meta: {
      source_type: "feishu_wiki",
      space_id: spaceId,
      synced_at: now,
      node_count: nodes.length,
    },
  };
}

export async function syncFeishuBitable(params: {
  appToken: string;
  tableId: string;
  datasetId: string;
  displayName?: string;
}): Promise<SyncedDatasetPayload> {
  const appToken = params.appToken.trim();
  const tableId = params.tableId.trim();
  const datasetId = params.datasetId.trim().toLowerCase();

  if (!/^[a-zA-Z0-9_-]{4,64}$/.test(appToken) || !/^[a-zA-Z0-9_-]{4,64}$/.test(tableId)) {
    throw new Error("无效的飞书多维表格 app_token 或 table_id");
  }
  if (!DATASET_SLUG_RE.test(datasetId)) {
    throw new Error("知识库标识仅支持字母、数字、下划线和短横线");
  }

  const recData = await feishuGet<{
    items?: Array<{ record_id?: string; fields?: Record<string, unknown> }>;
  }>(
    `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records?page_size=100`
  );

  const items = recData.items ?? [];
  const objects: KnowledgeObject[] = [];
  let hasHighTier = false;

  const pickField = (fields: Record<string, unknown>, names: string[]): string => {
    for (const n of names) {
      const v = fields[n];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (Array.isArray(v)) {
        const joined = v
          .map((item) =>
            typeof item === "string"
              ? item
              : item && typeof item === "object" && "text" in item
              ? String((item as { text?: unknown }).text ?? "")
              : ""
          )
          .filter(Boolean)
          .join("、");
        if (joined) return joined;
      }
    }
    return "";
  };

  items.forEach((item, idx) => {
    const fields = item.fields ?? {};
    const title = pickField(fields, ["标题", "条款名称", "名称", "title", "Title"]);
    const l0 = pickField(fields, ["L0", "公开内容", "公开条款", "全员可见", "public", "content"]);
    const l1 = pickField(fields, ["L1", "主管口径", "经理可见", "内部细则", "manager"]);
    const l2 = pickField(fields, ["L2", "HR细则", "高密内容", "机密条款", "hr", "restricted"]);
    const kwRaw = pickField(fields, ["关键词", "标签", "keywords"]);

    const levels: Record<string, string> = {};
    if (l0) levels["0"] = l0;
    if (l1) {
      levels["1"] = l1;
      hasHighTier = true;
    }
    if (l2) {
      levels["2"] = l2;
      hasHighTier = true;
    }
    if (!title || Object.keys(levels).length === 0) return;

    const kws = kwRaw
      ? kwRaw
          .split(/[、,，;；/\s]+/)
          .map((s) => s.trim())
          .filter((s) => s.length >= 2)
      : extractAutoKeywords(title, `${l0}\n${l1}\n${l2}`);

    objects.push({
      id: `bitable-${item.record_id ?? idx + 1}`,
      title: title.slice(0, 80),
      keywords: kws,
      levels,
    });
  });

  if (objects.length === 0) {
    throw new Error(
      "未从多维表格解析到有效条款（请确认表内包含「标题」以及「L0/公开内容」「L1/主管口径」「L2/HR细则」列）"
    );
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const name = params.displayName?.trim() || `飞书多维表格 (${tableId})`;

  return {
    dataset: datasetId,
    name,
    description: `同步自飞书多维表格 ${appToken}/${tableId}（共 ${objects.length} 条分级条款）`,
    objects,
    roles: { employee: 0, manager: 1, hr: 2 },
    permission_model: {
      authority: hasHighTier ? "customer" : "proposed",
      source: `飞书多维表格 ${appToken}/${tableId} 结构化列同步（${now}）`,
      principle: "按多维表格中业务方维护的 L0（公开）/ L1（主管）/ L2（HR）字段自动映射",
      warning: hasHighTier ? "" : "多维表格仅包含 L0 公开列，未配置高密级字段",
      may_claim_verified: hasHighTier,
    },
    probe_rules: [],
    precedent_cases: [],
    feishu_meta: {
      source_type: "feishu_bitable",
      app_token: appToken,
      table_id: tableId,
      synced_at: now,
      node_count: items.length,
    },
  };
}

export function buildDatasetFromFeishuMarkdown(params: {
  datasetId: string;
  displayName: string;
  markdown: string;
}): SyncedDatasetPayload {
  const datasetId = params.datasetId.trim().toLowerCase();
  if (!DATASET_SLUG_RE.test(datasetId)) {
    throw new Error("知识库标识仅支持字母、数字、下划线和短横线（1~48位）");
  }
  const parsed = parseTieredMarkdownToClauses(params.markdown, params.displayName);
  if (parsed.objects.length === 0) {
    throw new Error("未解析到有效条款正文，请至少包含一段内容或使用 # 标题分隔条款");
  }
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    dataset: datasetId,
    name: params.displayName.trim().slice(0, 80),
    description: `飞书分层文档导入（共 ${parsed.objects.length} 条条款）`,
    objects: parsed.objects,
    roles: { employee: 0, manager: 1, hr: 2 },
    permission_model: {
      authority: parsed.hasExplicitTiers ? "customer" : "proposed",
      source: `飞书文档 Markdown 显式分层导入（${now}）`,
      principle: parsed.hasExplicitTiers
        ? "按文档中显式标注的 [L0]/[L1]/[L2] 密级段落完成字段级隔离"
        : "未检测到高密级标签，当前全部条款归入 L0 公开层",
      warning: parsed.hasExplicitTiers
        ? ""
        : "如需隔离敏感内容，请在段落前添加 [L1] 或 [L2] 标记后重新导入",
      may_claim_verified: parsed.hasExplicitTiers,
    },
    probe_rules: [],
    precedent_cases: [],
    feishu_meta: {
      source_type: "feishu_doc",
      synced_at: now,
      node_count: parsed.objects.length,
    },
  };
}

export function saveSyncedDatasetFile(
  dataDir: string,
  payload: SyncedDatasetPayload
): string {
  const safeSlug = payload.dataset.replace(/[^a-z0-9_-]/gi, "");
  if (!safeSlug) {
    throw new Error("非法知识库文件名");
  }
  const resolvedBase = path.resolve(dataDir);
  const targetFile = path.resolve(resolvedBase, `gov_${safeSlug}.json`);
  if (!targetFile.startsWith(resolvedBase + path.sep)) {
    throw new Error("非法存储路径");
  }
  fs.mkdirSync(resolvedBase, { recursive: true });
  fs.writeFileSync(targetFile, JSON.stringify(payload, null, 2), "utf-8");
  return targetFile;
}
