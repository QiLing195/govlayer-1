/**
 * GovLayer 企业知识治理网关与飞书数据源服务（Node.js + Express + TypeScript）
 *
 * 接口：
 *   GET  /healthz                       → 健康检查
 *   GET  /api/datasets                  → 可用知识库 + 角色映射 + 分层来源 + 飞书元数据 + 实时准入策略
 *   GET  /api/tokens                    → 仅演示模式返回演示令牌（含部门属性）；配置 GOVLAYER_TOKENS 时不暴露
 *   POST /api/ask                       → {dataset, question, strict_mode?} → 治理后四态判定（实时执行 RBAC+ABAC）
 *   GET  /api/datasets/:id/clauses      → 按令牌权限与知识库策略过滤后的条款清单（零泄漏）
 *   GET  /api/datasets/:id/precedents   → 知识库先例列表（受 RBAC+ABAC 与先例读权限门控）
 *   POST /api/precedents                → 人工裁决沉淀为先例（需 L2 合规审计权限，写盘留痕）
 *   GET  /api/policies                  → 知识库 RBAC + ABAC 访问权限策略总览
 *   PUT  /api/policies/kb/:id           → 更新知识库准入级别/允许部门/密级/严格模式/LLM放行策略（需 L2）
 *   GET  /api/feishu/status             → 服务端飞书自建应用配置状态（只读，绝不返回 Secret）
 *   GET  /api/feishu/spaces             → 拉取飞书知识空间与组织部门清单（需 L2 + 服务端凭证）
 *   POST /api/feishu/sync/wiki          → 从飞书知识空间同步 docx 文档并热加载为受控知识库（需 L2）
 *   POST /api/feishu/sync/bitable       → 从飞书多维表格同步分级条款并热加载（需 L2）
 *   POST /api/feishu/import             → 导入飞书导出的 [L0]/[L1]/[L2] 分层 Markdown 文档并热加载（需 L2）
 *   POST /api/v1/gateway/govern         → 可插拔治理网关 API（支持 Authorization: Bearer 与 X-API-Token）
 *   POST /api/v1/chat/completions       → OpenAI 兼容治理代理（model: "govlayer:<dataset_id>"）
 *   GET  /api/audit                     → 审计日志列表 + 统计（需 L2 合规审计权限）
 *   GET  /api/audit/stats               → 审计统计（需 L2 合规审计权限）
 *   GET  /api/audit/export              → 审计日志合规 CSV 导出（需 L2 合规审计权限，防公式注入）
 *   GET  /*                             → React + Tailwind 前端控制台（dist/client）
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { AuditLog, questionField, tokenFingerprint } from "./src/audit.ts";
import type { AuditRecord } from "./src/audit.ts";
import {
  DEFAULT_DEPARTMENTS,
  DEMO_TOKENS,
  extractTokenFromHeaders,
  isDemoTokensActive,
  resolveIdentity,
  roleForLevel,
} from "./src/auth.ts";
import type { Identity } from "./src/auth.ts";
import {
  buildDatasetFromFeishuMarkdown,
  getFeishuStatus,
  listFeishuDepartments,
  listFeishuWikiSpaces,
  saveSyncedDatasetFile,
  syncFeishuBitable,
  syncFeishuWikiSpace,
} from "./src/feishu.ts";
import type { SyncedDatasetPayload } from "./src/feishu.ts";
import { GovLayer, loadDataset } from "./src/governance.ts";
import type {
  DatasetSpec,
  FeishuMeta,
  PermissionModel,
  PrecedentCase,
  RetrievalPreference,
  Verdict,
} from "./src/governance.ts";
import { PolicyStore } from "./src/policies.ts";
import type {
  DataClassification,
  KnowledgeBasePolicy,
  SourceType,
} from "./src/policies.ts";
import { LLMSemanticBackend } from "./src/semantic.ts";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const CLIENT_DIST_DIR = path.join(ROOT, "dist", "client");
const PRECEDENTS_LOG = path.resolve(ROOT, "audit", "precedents.jsonl");

const SLUG_RE = /^[a-z0-9_-]{1,64}$/i;

interface SamplePrompt {
  label: string;
  question: string;
  intent: string;
}

interface DatasetMeta {
  id: string;
  name: string;
  description: string;
  file: string;
  roles: Record<string, number>;
  n_objects: number;
  n_cases: number;
  llm_semantic: boolean;
  permission_model: PermissionModel;
  sample_questions: SamplePrompt[];
  source_type: SourceType;
  feishu_meta?: FeishuMeta;
}

const DATASET_DISPLAY: Record<string, { name: string; samples: SamplePrompt[] }> = {
  employee_rules: {
    name: "企业员工管理制度",
    samples: [
      { label: "公开条款", question: "公司上班和下班作息时间是几点？", intent: "全员可见" },
      { label: "高密截断", question: "旷工超过多少天会被劝退？", intent: "L0 受限 / L2 可答" },
      { label: "制度空白", question: "出差原定2天结果待了5天，超出报备天数怎么处理？", intent: "空白 + 先例" },
      { label: "错别字容错", question: "矿工或忘打刻怎么处理？", intent: "自动纠错留痕" },
    ],
  },
  registration: {
    name: "高校迎新线上报到流程",
    samples: [
      { label: "公开指引", question: "证件照要求什么底色和像素大小？", intent: "学生可见" },
      { label: "审核细则", question: "绿色通道缓缴学费的审批周期和额度上限是多少？", intent: "L0 受限 / L1 可答" },
      { label: "账号锁定", question: "激活账号连续输错密码会锁定多久？", intent: "L0 受限 / L1 可答" },
      { label: "范围外", question: "学校食堂几点开饭？", intent: "诚实拒答" },
    ],
  },
  renshi: {
    name: "事业单位人事管理条例",
    samples: [
      { label: "公开招聘", question: "事业单位公开招聘工作人员按照哪些程序进行？", intent: "全员可见" },
      { label: "主管部门", question: "岗位设置方案需要向哪个部门备案？", intent: "L0 受限 / L1 可答" },
      { label: "法律责任", question: "人事处理造成名誉损害或经济损失如何追责？", intent: "L0 受限 / L2 可答" },
      { label: "范围外", question: "办公楼停车费怎么报销？", intent: "诚实拒答" },
    ],
  },
  kaohe: {
    name: "事业单位工作人员考核规定",
    samples: [
      { label: "考核档次", question: "年度考核结果一般分为哪几个档次？", intent: "全员可见" },
      { label: "考核内容", question: "事业单位工作人员考核重点关注德能勤绩廉哪些方面？", intent: "全员可见" },
      { label: "分级分类", question: "年度考核一般在什么时间周期进行？", intent: "全员可见" },
      { label: "范围外", question: "年度考核优秀发多少年终奖？", intent: "诚实拒答" },
    ],
  },
};

const SEMANTIC = new LLMSemanticBackend();
const AUDIT = new AuditLog();

const LAYERS = new Map<string, GovLayer>();
const DATASETS = new Map<string, DatasetMeta>();
const SYNCED_FEISHU_DEPARTMENTS = new Set<string>();

function retrievalPreference(): RetrievalPreference {
  const rawPref = (process.env.GOVLAYER_RETRIEVAL ?? "auto").trim().toLowerCase() || "auto";
  return rawPref === "auto" || rawPref === "local" || rawPref === "llm" ? rawPref : "auto";
}

function getAllDepartments(): string[] {
  const merged = new Set<string>(DEFAULT_DEPARTMENTS);
  for (const d of SYNCED_FEISHU_DEPARTMENTS) {
    merged.add(d);
  }
  return Array.from(merged);
}

interface PersistedPrecedentEntry {
  dataset: string;
  case: PrecedentCase;
}

function registerDatasetSpec(
  datasetId: string,
  file: string,
  spec: DatasetSpec
): DatasetMeta {
  const display = DATASET_DISPLAY[datasetId];
  const sourceType: SourceType = spec.feishu_meta?.source_type ?? "local";

  LAYERS.set(
    datasetId,
    new GovLayer({
      objects: spec.objects,
      roles: spec.roles,
      probePairs: spec.probe_rules,
      cases: spec.cases,
      semanticBackend: SEMANTIC.available ? SEMANTIC : null,
      retrievalPreference: retrievalPreference(),
    })
  );

  const meta: DatasetMeta = {
    id: datasetId,
    name: display?.name ?? spec.name ?? (spec.description || datasetId),
    description: spec.description || datasetId,
    file,
    roles: spec.roles,
    n_objects: spec.objects.length,
    n_cases: spec.cases.length,
    llm_semantic: SEMANTIC.available,
    permission_model: spec.permission_model,
    sample_questions: display?.samples ?? [],
    source_type: sourceType,
    feishu_meta: spec.feishu_meta,
  };
  DATASETS.set(datasetId, meta);
  return meta;
}

function loadPersistedPrecedents(): void {
  try {
    if (!fs.existsSync(PRECEDENTS_LOG)) return;
    const lines = fs.readFileSync(PRECEDENTS_LOG, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as PersistedPrecedentEntry;
        const layer = LAYERS.get(parsed.dataset);
        const meta = DATASETS.get(parsed.dataset);
        if (layer && meta && parsed.case && parsed.case.ruling) {
          const exists = layer.cases.some((c) => c.case_id === parsed.case.case_id);
          if (!exists) {
            layer.cases.push(parsed.case);
            meta.n_cases = layer.cases.length;
          }
        }
      } catch {
        // Ignore malformed lines
      }
    }
  } catch {
    // Best-effort startup recovery
  }
}

function persistPrecedent(dataset: string, entry: PrecedentCase): void {
  try {
    fs.mkdirSync(path.dirname(PRECEDENTS_LOG), { recursive: true });
    fs.appendFileSync(
      PRECEDENTS_LOG,
      JSON.stringify({ dataset, case: entry }) + "\n",
      "utf-8"
    );
  } catch {
    // Best-effort persistence
  }
}

function loadAllDatasets(): void {
  if (!fs.existsSync(DATA_DIR)) {
    console.warn(`[govlayer] data directory not found: ${DATA_DIR}`);
    return;
  }

  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith("gov_") && f.endsWith(".json"))
    .sort();

  for (const file of files) {
    const fullPath = path.join(DATA_DIR, file);
    const spec = loadDataset(fullPath);
    const datasetId = file.replace(/^gov_/, "").replace(/\.json$/, "");
    registerDatasetSpec(datasetId, file, spec);
  }

  loadPersistedPrecedents();
}

loadAllDatasets();

const POLICIES = new PolicyStore(
  Array.from(DATASETS.values()).map((d) => ({ id: d.id, sourceType: d.source_type }))
);

function registerSyncedPayload(payload: SyncedDatasetPayload): DatasetMeta {
  const savedFile = saveSyncedDatasetFile(DATA_DIR, payload);
  const spec = loadDataset(savedFile);
  const meta = registerDatasetSpec(payload.dataset, path.basename(savedFile), spec);
  POLICIES.ensureKnowledgeBase(payload.dataset, payload.feishu_meta.source_type);
  return meta;
}

async function llmAnswer(
  question: string,
  visibleContext: string,
  verdict: string
): Promise<string | null> {
  const key = process.env.DEEPSEEK_API_KEY ?? "";
  if (!key || verdict === "gap" || verdict === "restricted") {
    return null;
  }
  const system =
    "你是企业知识库助手。只能依据下方【已授权资料】回答；" +
    "资料不足时必须回答'根据现有资料无法回答'，不得编造任何制度条款。";
  const prompt = `【已授权资料】\n${visibleContext}\n\n【员工提问】${question}\n\n【回答】`;

  try {
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      return null;
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

function auditorLevel(): number {
  let maxLvl = 2;
  for (const spec of DATASETS.values()) {
    for (const lvl of Object.values(spec.roles)) {
      if (lvl > maxLvl) {
        maxLvl = lvl;
      }
    }
  }
  return maxLvl;
}

function getApiToken(req: Request): string | undefined {
  return extractTokenFromHeaders(
    req.header("X-API-Token"),
    req.header("Authorization")
  );
}

function requireAuditor(
  req: Request,
  res: Response,
  scope = "audit"
): Identity | null {
  const token = getApiToken(req);
  const ident = resolveIdentity(token, null, {});
  if (!ident) {
    AUDIT.record({
      event: "auth_failed",
      scope,
      reason: "invalid_or_missing_token",
      status: 401,
      token_fp: tokenFingerprint(token),
    });
    res.status(401).json({
      detail: "缺少或无效的身份令牌（请在 X-API-Token 或 Authorization: Bearer 头提供）",
    });
    return null;
  }
  const required = auditorLevel();
  if (ident.level < required) {
    AUDIT.record({
      event: "audit_denied",
      scope,
      reason: "level_below_auditor",
      level: ident.level,
      identity_label: ident.label,
      department: ident.department,
      status: 403,
      token_fp: tokenFingerprint(token),
    });
    res
      .status(403)
      .json({ detail: `该操作需要最高合规审计权限（级别 ≥ L${required}）` });
    return null;
  }
  return ident;
}

function cleanString(val: unknown, maxLen: number): string {
  if (typeof val !== "string") return "";
  return val.trim().slice(0, maxLen);
}

function checkKnowledgeBaseGate(
  policy: KnowledgeBasePolicy,
  identity: Identity
): { ok: true } | { ok: false; reason: string; detail: string } {
  if (!policy.enabled) {
    return {
      ok: false,
      reason: "kb_policy_disabled",
      detail: `知识库「${policy.dataset_id}」当前已被访问策略停用`,
    };
  }
  if (identity.level < policy.min_level) {
    return {
      ok: false,
      reason: "kb_policy_min_level",
      detail: `知识库访问策略要求权限级别 ≥ L${policy.min_level}，你的当前级别为 L${identity.level}`,
    };
  }
  // ABAC 部门边界隔离（L2 合规审计员保留全域审计与管理视界，非审计角色严格按部门匹配）
  if (
    policy.allowed_departments.length > 0 &&
    identity.level < auditorLevel() &&
    !policy.allowed_departments.includes(identity.department)
  ) {
    return {
      ok: false,
      reason: "kb_policy_department_denied",
      detail: `该知识库仅向 [${policy.allowed_departments.join("、")}] 开放，你的所属部门为「${identity.department}」`,
    };
  }
  return { ok: true };
}

interface GovernedAskResult {
  httpStatus: number;
  errorDetail?: string;
  auditId: string;
  payload?: {
    audit_id: string;
    dataset: string;
    question: string;
    role: string;
    level: number;
    department: string;
    verdict: Verdict;
    allowed_to_call_llm: boolean;
    safe_context: string;
    answer_text: string;
    visible_sources: Array<{ id: string; title: string; content: string }>;
    denied_fields: string[];
    precedents: Array<{
      case_id?: string;
      topic?: string;
      ruling?: string;
      reasoning?: string;
      approver?: string;
      date?: string;
      reference_only?: boolean;
    }>;
    boundary_note: string;
    typo_corrections: string[];
    semantic_used: boolean;
    retrieval_mode: string;
    strict_mode: boolean;
    identity: string;
    llm_used: boolean;
    latency_ms: number;
  };
}

async function executeGovernedAsk(params: {
  dataset: string;
  question: string;
  requestedStrictMode: boolean;
  claimedRole: string | null;
  token: string | undefined;
  auditEvent: "ask" | "gateway_call";
  scope?: string;
  skipLlmSynthesis?: boolean;
}): Promise<GovernedAskResult> {
  const t0 = performance.now();
  const auditId = `aud_${crypto.randomBytes(6).toString("hex")}`;

  const rec: AuditRecord = {
    audit_id: auditId,
    dataset: params.dataset,
    scope: params.scope,
    strict_mode: params.requestedStrictMode,
    token_fp: tokenFingerprint(params.token),
    ...questionField(params.question),
  };

  try {
    const existingLayer = LAYERS.get(params.dataset);
    const roleLevels = existingLayer ? existingLayer.roles : {};
    const identity = resolveIdentity(params.token, params.claimedRole, roleLevels);

    if (!identity) {
      delete rec.question;
      delete rec.question_sha256;
      delete rec.question_redacted;
      rec.question_withheld = "unauthenticated";
      rec.event = "auth_failed";
      rec.reason = "invalid_or_missing_token";
      rec.status = 401;
      return {
        httpStatus: 401,
        errorDetail:
          "缺少或无效的身份令牌（请在 X-API-Token 或 Authorization: Bearer 头提供）",
        auditId,
      };
    }

    rec.identity_label = identity.label;
    rec.department = identity.department;
    rec.level = identity.level;

    if (!existingLayer) {
      rec.event = "ask_denied";
      rec.reason = "unknown_dataset";
      rec.status = 404;
      return {
        httpStatus: 404,
        errorDetail: `unknown dataset: ${params.dataset}`,
        auditId,
      };
    }

    // 实时执行 RBAC + ABAC 知识库准入策略
    const kbPolicy = POLICIES.getKnowledgeBasePolicy(params.dataset);
    const gate = checkKnowledgeBaseGate(kbPolicy, identity);
    if (!gate.ok) {
      rec.event = "ask_denied";
      rec.reason = gate.reason;
      rec.status = 403;
      return {
        httpStatus: 403,
        errorDetail: gate.detail,
        auditId,
      };
    }

    const role = roleForLevel(existingLayer.roles, identity.level);
    if (!role) {
      rec.event = "ask_denied";
      rec.reason = "level_below_dataset_minimum";
      rec.status = 403;
      return {
        httpStatus: 403,
        errorDetail: `你的权限级别 L${identity.level} 无权访问该知识库`,
        auditId,
      };
    }
    rec.role = role;

    const effectiveStrict = params.requestedStrictMode || kbPolicy.default_strict_mode;
    rec.strict_mode = effectiveStrict;

    const ans = await existingLayer.answer(params.question, role, {
      strictMode: effectiveStrict,
    });

    const sources: Array<{ id: string; title: string; content: string }> = [];
    for (const [oid, content] of Object.entries(ans.visible_texts)) {
      const obj = existingLayer.objects.find((o) => o.id === oid);
      sources.push({
        id: oid,
        title: obj?.title ?? oid,
        content: content || "（无权限查看此内容）",
      });
    }

    const visibleContext = sources
      .filter((s) => s.content && !s.content.includes("无权限"))
      .map((s) => `《${s.title}》：${s.content}`)
      .join("\n---\n");

    const allowedToCallLlm =
      kbPolicy.allow_llm &&
      ans.verdict === "covered" &&
      visibleContext.trim().length > 0;

    let llmText: string | null = null;
    if (!params.skipLlmSynthesis && allowedToCallLlm) {
      llmText = await llmAnswer(params.question, visibleContext, ans.verdict);
    }

    let answerText: string;
    if (ans.verdict === "restricted") {
      answerText =
        ans.boundary_note || "该问题涉及的信息超出你的角色权限范围。";
    } else if (llmText) {
      answerText = llmText;
    } else if (ans.verdict === "gap") {
      answerText = "根据现有制度无法回答此问题。" + (ans.boundary_note || "");
    } else if (ans.verdict === "out_of_scope") {
      answerText = effectiveStrict
        ? "在你可见的权限范围内未找到相关制度条款，如需进一步确认请联系 HR 或管理员。"
        : "此问题不在已登记制度范围内，建议咨询 HR 或业务负责人。";
    } else {
      answerText = visibleContext || "根据你的权限，没有可展示的内容。";
    }

    const visiblePrecedents =
      identity.level >= kbPolicy.allow_precedent_read ? ans.precedents : [];

    const latencyMs = Math.round((performance.now() - t0) * 10) / 10;

    rec.event = params.auditEvent;
    rec.status = 200;
    rec.verdict = ans.verdict;
    rec.hit_ids = [...ans.hit_ids];
    rec.denied_fields = [...ans.denied_fields];
    rec.n_sources = sources.length;
    rec.semantic_used = Boolean(ans.semantic_used);
    rec.retrieval_mode = ans.retrieval_mode;
    rec.llm_used = Boolean(llmText);
    rec.typo_corrections = [...ans.typo_corrections];
    rec.latency_ms = latencyMs;

    return {
      httpStatus: 200,
      auditId,
      payload: {
        audit_id: auditId,
        dataset: params.dataset,
        question: params.question,
        role,
        level: identity.level,
        department: identity.department,
        verdict: ans.verdict,
        allowed_to_call_llm: allowedToCallLlm,
        safe_context: allowedToCallLlm ? visibleContext : "",
        answer_text: answerText,
        visible_sources: sources,
        denied_fields: ans.denied_fields,
        precedents: visiblePrecedents.map((c) => ({
          case_id: c.case_id,
          topic: c.topic,
          ruling: c.ruling,
          reasoning: c.reasoning,
          approver: c.approver,
          date: c.date,
          reference_only: c.reference_only,
        })),
        boundary_note: ans.boundary_note || "",
        typo_corrections: ans.typo_corrections,
        semantic_used: ans.semantic_used,
        retrieval_mode: ans.retrieval_mode,
        strict_mode: effectiveStrict,
        identity: `${identity.label} · ${identity.department}（L${identity.level} → ${role}）`,
        llm_used: Boolean(llmText),
        latency_ms: latencyMs,
      },
    };
  } catch (err) {
    console.error("[govlayer] governed ask error:", err);
    rec.event = "error";
    rec.status = 500;
    return {
      httpStatus: 500,
      errorDetail: "服务内部错误",
      auditId,
    };
  } finally {
    if (rec.latency_ms === undefined) {
      rec.latency_ms = Math.round((performance.now() - t0) * 10) / 10;
    }
    AUDIT.record(rec);
  }
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    datasets: Array.from(DATASETS.keys()),
    llm_semantic: SEMANTIC.available,
    feishu_configured: getFeishuStatus().configured,
    demo_mode: isDemoTokensActive(),
  });
});

app.get("/api/datasets", (_req: Request, res: Response) => {
  const list = Array.from(DATASETS.values()).map((meta) => ({
    ...meta,
    policy: POLICIES.getKnowledgeBasePolicy(meta.id),
  }));
  res.json(list);
});

app.get("/api/tokens", (_req: Request, res: Response) => {
  if (!isDemoTokensActive()) {
    res.json({ demo_mode: false, tokens: [] });
    return;
  }
  const tokens = Object.entries(DEMO_TOKENS).map(([token, info]) => ({
    token,
    label: info.label,
    level: info.level,
    department: info.department,
    role_tag: info.role_tag ?? `l${info.level}`,
  }));
  res.json({ demo_mode: true, tokens });
});

// ---- 知识库访问权限策略管理（RBAC + ABAC） ----

app.get("/api/policies", (req: Request, res: Response) => {
  const token = getApiToken(req);
  const ident = resolveIdentity(token, null, {});
  if (!ident) {
    res.status(401).json({
      detail: "缺少或无效的身份令牌（请在 X-API-Token 或 Authorization: Bearer 头提供）",
    });
    return;
  }

  const kbPolicies = POLICIES.listKnowledgeBasePolicies()
    .filter((p) => DATASETS.has(p.dataset_id))
    .map((p) => {
      const meta = DATASETS.get(p.dataset_id)!;
      return {
        ...p,
        name: meta.name,
        n_objects: meta.n_objects,
        roles: meta.roles,
        source_type: meta.source_type,
      };
    });

  res.json({
    can_manage: ident.level >= auditorLevel(),
    caller_level: ident.level,
    caller_identity: ident.label,
    caller_department: ident.department,
    auditor_level: auditorLevel(),
    departments: getAllDepartments(),
    knowledge_bases: kbPolicies,
  });
});

app.put("/api/policies/kb/:id", (req: Request, res: Response) => {
  const ident = requireAuditor(req, res, "policies");
  if (!ident) return;

  const datasetId = String(req.params.id ?? "");
  if (!SLUG_RE.test(datasetId) || !DATASETS.has(datasetId)) {
    res.status(404).json({ detail: `unknown dataset: ${datasetId}` });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const allowedDepartments = Array.isArray(body.allowed_departments)
    ? body.allowed_departments
        .filter((d): d is string => typeof d === "string")
        .map((d) => d.trim())
        .filter(Boolean)
    : undefined;

  const validClasses: DataClassification[] = [
    "public",
    "internal",
    "confidential",
    "restricted",
  ];
  const classification =
    typeof body.classification === "string" &&
    validClasses.includes(body.classification as DataClassification)
      ? (body.classification as DataClassification)
      : undefined;

  const updated = POLICIES.updateKnowledgeBasePolicy(
    datasetId,
    {
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      min_level:
        typeof body.min_level === "number" && Number.isFinite(body.min_level)
          ? body.min_level
          : undefined,
      allowed_departments: allowedDepartments,
      classification,
      default_strict_mode:
        typeof body.default_strict_mode === "boolean"
          ? body.default_strict_mode
          : undefined,
      allow_llm: typeof body.allow_llm === "boolean" ? body.allow_llm : undefined,
      allow_precedent_read:
        typeof body.allow_precedent_read === "number" &&
        Number.isFinite(body.allow_precedent_read)
          ? body.allow_precedent_read
          : undefined,
    },
    `${ident.label} (${ident.department})`
  );

  if (!updated) {
    res.status(404).json({ detail: `unknown dataset: ${datasetId}` });
    return;
  }

  const deptDesc =
    updated.allowed_departments.length > 0
      ? updated.allowed_departments.join("|")
      : "全部门";

  AUDIT.record({
    event: "policy_updated",
    scope: "kb_policy",
    dataset: datasetId,
    resource: `kb:${datasetId}`,
    action: `enabled=${updated.enabled}, min_level=L${updated.min_level}, depts=${deptDesc}, class=${updated.classification}, strict=${updated.default_strict_mode}, llm=${updated.allow_llm}`,
    status: 200,
    identity_label: ident.label,
    department: ident.department,
    level: ident.level,
    token_fp: tokenFingerprint(getApiToken(req)),
  });

  res.json(updated);
});

// ---- 飞书开放平台数据源接入与同步（无假库、凭证仅存服务端环境变量） ----

app.get("/api/feishu/status", (req: Request, res: Response) => {
  const token = getApiToken(req);
  const ident = resolveIdentity(token, null, {});
  if (!ident) {
    res.status(401).json({
      detail: "缺少或无效的身份令牌（请在 X-API-Token 或 Authorization: Bearer 头提供）",
    });
    return;
  }
  res.json({
    ...getFeishuStatus(),
    can_manage: ident.level >= auditorLevel(),
    departments: getAllDepartments(),
  });
});

app.get("/api/feishu/spaces", async (req: Request, res: Response) => {
  const ident = requireAuditor(req, res, "feishu");
  if (!ident) return;

  if (!getFeishuStatus().configured) {
    res.status(400).json({
      detail:
        "服务端尚未配置 FEISHU_APP_ID 与 FEISHU_APP_SECRET，请先在环境变量中配置飞书自建应用凭证后重试。",
    });
    return;
  }

  try {
    const [spaces, depts] = await Promise.all([
      listFeishuWikiSpaces(),
      listFeishuDepartments().catch(() => []),
    ]);
    for (const d of depts) {
      if (d.name) SYNCED_FEISHU_DEPARTMENTS.add(d.name);
    }
    res.json({
      spaces,
      departments: getAllDepartments(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "拉取飞书知识空间失败";
    res.status(502).json({ detail: message });
  }
});

app.post("/api/feishu/sync/wiki", async (req: Request, res: Response) => {
  const t0 = performance.now();
  const ident = requireAuditor(req, res, "feishu_sync");
  if (!ident) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const spaceId = cleanString(body.space_id, 64) || getFeishuStatus().default_space_id;
  const datasetId = cleanString(body.dataset_id, 48).toLowerCase();
  const displayName = cleanString(body.display_name, 80);

  if (!spaceId || !datasetId) {
    res.status(422).json({ detail: "请提供飞书知识空间 space_id 与目标知识库标识" });
    return;
  }

  try {
    const payload = await syncFeishuWikiSpace({
      spaceId,
      datasetId,
      displayName: displayName || undefined,
    });
    const meta = registerSyncedPayload(payload);

    AUDIT.record({
      event: "feishu_sync",
      scope: "feishu_wiki",
      dataset: meta.id,
      resource: `feishu:wiki:${spaceId}`,
      action: `synced ${meta.n_objects} clauses`,
      status: 201,
      identity_label: ident.label,
      department: ident.department,
      level: ident.level,
      token_fp: tokenFingerprint(getApiToken(req)),
      latency_ms: Math.round((performance.now() - t0) * 10) / 10,
    });

    res.status(201).json({
      dataset: meta,
      policy: POLICIES.getKnowledgeBasePolicy(meta.id),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "同步飞书知识空间失败";
    res.status(400).json({ detail: message });
  }
});

app.post("/api/feishu/sync/bitable", async (req: Request, res: Response) => {
  const t0 = performance.now();
  const ident = requireAuditor(req, res, "feishu_sync");
  if (!ident) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const appToken = cleanString(body.app_token, 64);
  const tableId = cleanString(body.table_id, 64);
  const datasetId = cleanString(body.dataset_id, 48).toLowerCase();
  const displayName = cleanString(body.display_name, 80);

  if (!appToken || !tableId || !datasetId) {
    res.status(422).json({
      detail: "请提供飞书多维表格 app_token、table_id 与目标知识库标识",
    });
    return;
  }

  try {
    const payload = await syncFeishuBitable({
      appToken,
      tableId,
      datasetId,
      displayName: displayName || undefined,
    });
    const meta = registerSyncedPayload(payload);

    AUDIT.record({
      event: "feishu_sync",
      scope: "feishu_bitable",
      dataset: meta.id,
      resource: `feishu:bitable:${appToken}/${tableId}`,
      action: `synced ${meta.n_objects} tiered clauses`,
      status: 201,
      identity_label: ident.label,
      department: ident.department,
      level: ident.level,
      token_fp: tokenFingerprint(getApiToken(req)),
      latency_ms: Math.round((performance.now() - t0) * 10) / 10,
    });

    res.status(201).json({
      dataset: meta,
      policy: POLICIES.getKnowledgeBasePolicy(meta.id),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "同步飞书多维表格失败";
    res.status(400).json({ detail: message });
  }
});

app.post("/api/feishu/import", (req: Request, res: Response) => {
  const t0 = performance.now();
  const ident = requireAuditor(req, res, "feishu_sync");
  if (!ident) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const datasetId = cleanString(body.dataset_id, 48).toLowerCase();
  const displayName = cleanString(body.display_name, 80);
  const markdown = typeof body.markdown === "string" ? body.markdown.slice(0, 120_000) : "";

  if (!datasetId || !displayName || !markdown.trim()) {
    res.status(422).json({
      detail: "知识库标识、名称与飞书分层文档正文均为必填项",
    });
    return;
  }

  try {
    const payload = buildDatasetFromFeishuMarkdown({
      datasetId,
      displayName,
      markdown,
    });
    const meta = registerSyncedPayload(payload);

    AUDIT.record({
      event: "feishu_sync",
      scope: "feishu_doc_import",
      dataset: meta.id,
      resource: `feishu:doc:${meta.id}`,
      action: `imported ${meta.n_objects} clauses`,
      status: 201,
      identity_label: ident.label,
      department: ident.department,
      level: ident.level,
      token_fp: tokenFingerprint(getApiToken(req)),
      latency_ms: Math.round((performance.now() - t0) * 10) / 10,
    });

    res.status(201).json({
      dataset: meta,
      policy: POLICIES.getKnowledgeBasePolicy(meta.id),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "导入飞书分层文档失败";
    res.status(422).json({ detail: message });
  }
});

// ---- 知识库条款、先例与合规问答（实时执行 RBAC + ABAC） ----

app.get("/api/datasets/:id/clauses", (req: Request, res: Response) => {
  const datasetId = String(req.params.id ?? "");
  const token = getApiToken(req);
  const existingLayer = SLUG_RE.test(datasetId) ? LAYERS.get(datasetId) : undefined;
  const identity = resolveIdentity(token, null, existingLayer ? existingLayer.roles : {});

  if (!identity) {
    AUDIT.record({
      event: "auth_failed",
      scope: "clauses",
      dataset: datasetId,
      reason: "invalid_or_missing_token",
      status: 401,
      token_fp: tokenFingerprint(token),
    });
    res.status(401).json({
      detail: "缺少或无效的身份令牌（请在 X-API-Token 或 Authorization: Bearer 头提供）",
    });
    return;
  }

  if (!existingLayer) {
    res.status(404).json({ detail: `unknown dataset: ${datasetId}` });
    return;
  }

  const kbPolicy = POLICIES.getKnowledgeBasePolicy(datasetId);
  const gate = checkKnowledgeBaseGate(kbPolicy, identity);
  if (!gate.ok) {
    AUDIT.record({
      event: "ask_denied",
      scope: "clauses",
      dataset: datasetId,
      reason: gate.reason,
      identity_label: identity.label,
      department: identity.department,
      level: identity.level,
      status: 403,
      token_fp: tokenFingerprint(token),
    });
    res.status(403).json({ detail: gate.detail });
    return;
  }

  const role = roleForLevel(existingLayer.roles, identity.level);
  if (!role) {
    res
      .status(403)
      .json({ detail: `你的权限级别 L${identity.level} 无权访问该知识库` });
    return;
  }

  const meta = DATASETS.get(datasetId)!;
  const compliance = existingLayer.evaluateCompliance({
    role,
    permissionModel: meta.permission_model,
    policy: kbPolicy,
  });

  res.json({
    dataset: datasetId,
    role,
    level: identity.level,
    department: identity.department,
    identity: `${identity.label} · ${identity.department}（L${identity.level} → ${role}）`,
    compliance,
    clauses: existingLayer.getVisibleClauses(
      role,
      meta.permission_model.may_claim_verified
    ),
  });
});

app.post("/api/datasets/:id/risk-scan", (req: Request, res: Response) => {
  const t0 = performance.now();
  const datasetId = String(req.params.id ?? "");
  const token = getApiToken(req);
  const existingLayer = SLUG_RE.test(datasetId) ? LAYERS.get(datasetId) : undefined;
  const identity = resolveIdentity(token, null, existingLayer ? existingLayer.roles : {});

  if (!identity) {
    AUDIT.record({
      event: "auth_failed",
      scope: "risk_scan",
      dataset: datasetId,
      reason: "invalid_or_missing_token",
      status: 401,
      token_fp: tokenFingerprint(token),
    });
    res.status(401).json({
      detail: "缺少或无效的身份令牌（请在 X-API-Token 或 Authorization: Bearer 头提供）",
    });
    return;
  }

  if (!existingLayer) {
    res.status(404).json({ detail: `unknown dataset: ${datasetId}` });
    return;
  }

  const kbPolicy = POLICIES.getKnowledgeBasePolicy(datasetId);
  const gate = checkKnowledgeBaseGate(kbPolicy, identity);
  if (!gate.ok) {
    AUDIT.record({
      event: "ask_denied",
      scope: "risk_scan",
      dataset: datasetId,
      reason: gate.reason,
      identity_label: identity.label,
      department: identity.department,
      level: identity.level,
      status: 403,
      token_fp: tokenFingerprint(token),
    });
    res.status(403).json({ detail: gate.detail });
    return;
  }

  const role = roleForLevel(existingLayer.roles, identity.level);
  if (!role) {
    res
      .status(403)
      .json({ detail: `你的权限级别 L${identity.level} 无权扫描该知识库` });
    return;
  }

  const meta = DATASETS.get(datasetId)!;
  const report = existingLayer.scanComplianceRisks({
    role,
    permissionModel: meta.permission_model,
    policy: kbPolicy,
  });

  AUDIT.record({
    event: "risk_scan",
    scope: "risk_scan",
    dataset: datasetId,
    resource: `kb:${datasetId}`,
    action: `score=${report.compliance_score}, findings=${report.total_findings} (high=${report.high_count}, med=${report.medium_count})`,
    status: 200,
    identity_label: identity.label,
    department: identity.department,
    level: identity.level,
    role,
    token_fp: tokenFingerprint(token),
    latency_ms: Math.round((performance.now() - t0) * 10) / 10,
  });

  res.json({
    dataset: datasetId,
    dataset_name: meta.name,
    role,
    level: identity.level,
    identity: `${identity.label} · ${identity.department}（L${identity.level} → ${role}）`,
    report,
  });
});

app.get("/api/datasets/:id/precedents", (req: Request, res: Response) => {
  const datasetId = String(req.params.id ?? "");
  const token = getApiToken(req);
  const existingLayer = SLUG_RE.test(datasetId) ? LAYERS.get(datasetId) : undefined;
  const identity = resolveIdentity(token, null, existingLayer ? existingLayer.roles : {});

  if (!identity) {
    res.status(401).json({
      detail: "缺少或无效的身份令牌（请在 X-API-Token 或 Authorization: Bearer 头提供）",
    });
    return;
  }

  if (!existingLayer) {
    res.status(404).json({ detail: `unknown dataset: ${datasetId}` });
    return;
  }

  const kbPolicy = POLICIES.getKnowledgeBasePolicy(datasetId);
  const gate = checkKnowledgeBaseGate(kbPolicy, identity);
  if (!gate.ok) {
    res.status(403).json({ detail: gate.detail });
    return;
  }
  if (identity.level < kbPolicy.allow_precedent_read) {
    res.status(403).json({
      detail: `查阅该知识库的历史先例需要权限级别 ≥ L${kbPolicy.allow_precedent_read}`,
    });
    return;
  }

  res.json({
    dataset: datasetId,
    can_manage: identity.level >= auditorLevel(),
    precedents: [...existingLayer.cases].reverse(),
  });
});

app.post("/api/precedents", (req: Request, res: Response) => {
  const ident = requireAuditor(req, res, "precedents");
  if (!ident) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const dataset = cleanString(body.dataset, 64);
  const topic = cleanString(body.topic, 80);
  const question = cleanString(body.question, 500);
  const context = cleanString(body.context, 500);
  const ruling = cleanString(body.ruling, 1000);
  const reasoning = cleanString(body.reasoning, 1000);
  const approver = cleanString(body.approver, 80) || ident.label;
  const department = cleanString(body.department, 80) || ident.department;

  if (!SLUG_RE.test(dataset) || !LAYERS.has(dataset)) {
    res.status(404).json({ detail: "无效的知识库标识" });
    return;
  }
  if (!topic || !question || !ruling) {
    res.status(422).json({ detail: "主题、原始问题与裁决结论为必填项" });
    return;
  }

  const layer = LAYERS.get(dataset)!;
  const created = layer.addPrecedent({
    topic,
    question,
    context: context || "人工升级裁决",
    ruling,
    reasoning: reasoning || "由合规管理员在治理台登记",
    approver,
    department,
  });

  const meta = DATASETS.get(dataset);
  if (meta) {
    meta.n_cases = layer.cases.length;
  }
  persistPrecedent(dataset, created);

  AUDIT.record({
    event: "precedent_created",
    scope: "precedents",
    dataset,
    status: 201,
    identity_label: ident.label,
    department: ident.department,
    level: ident.level,
    role: roleForLevel(layer.roles, ident.level) ?? "auditor",
    case_id: created.case_id,
    token_fp: tokenFingerprint(getApiToken(req)),
    ...questionField(question),
  });

  res.status(201).json(created);
});

app.post("/api/preflight", (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const dataset = cleanString(body.dataset, 64);
  const question = cleanString(body.question, 1000);
  const requestedStrictMode = Boolean(body.strict_mode);

  const token = getApiToken(req);
  const existingLayer = SLUG_RE.test(dataset) ? LAYERS.get(dataset) : undefined;
  const identity = resolveIdentity(token, null, existingLayer ? existingLayer.roles : {});

  if (!identity) {
    res.status(401).json({
      detail: "缺少或无效的身份令牌（请在 X-API-Token 或 Authorization: Bearer 头提供）",
    });
    return;
  }

  if (!existingLayer) {
    res.status(404).json({ detail: `unknown dataset: ${dataset}` });
    return;
  }

  const kbPolicy = POLICIES.getKnowledgeBasePolicy(dataset);
  const gate = checkKnowledgeBaseGate(kbPolicy, identity);
  if (!gate.ok) {
    res.json({
      status: "blocked",
      risk_level: "high",
      reason: gate.reason,
      caller_level: identity.level,
      required_level: kbPolicy.min_level,
      affected_count: 0,
      strict_suppressed: false,
      typo_corrections: [],
      warning_title: "当前知识库准入策略受限",
      warning_detail: gate.detail,
    });
    return;
  }

  const role = roleForLevel(existingLayer.roles, identity.level);
  if (!role) {
    res.json({
      status: "blocked",
      risk_level: "high",
      reason: "level_below_dataset_minimum",
      caller_level: identity.level,
      required_level: Math.min(...Object.values(existingLayer.roles), 0),
      affected_count: 0,
      strict_suppressed: false,
      typo_corrections: [],
      warning_title: "角色权限级别不足",
      warning_detail: `你的权限级别 L${identity.level} 无权查询该知识库。`,
    });
    return;
  }

  if (question.length < 2) {
    res.json({
      status: "clear",
      risk_level: "none",
      caller_level: identity.level,
      required_level: identity.level,
      affected_count: 0,
      strict_suppressed: false,
      typo_corrections: [],
      warning_title: "",
      warning_detail: "",
    });
    return;
  }

  // 严格隔离模式下禁止实时探测高密条款存在性，防止侧信道枚举
  const effectiveStrict = requestedStrictMode || kbPolicy.default_strict_mode;
  if (effectiveStrict) {
    res.json({
      status: "strict_suppressed",
      risk_level: "none",
      caller_level: identity.level,
      required_level: identity.level,
      affected_count: 0,
      strict_suppressed: true,
      typo_corrections: [],
      warning_title: "",
      warning_detail: "",
    });
    return;
  }

  const check = existingLayer.preflight(question, role);
  if (check.status === "restricted") {
    res.json({
      status: "restricted",
      risk_level: "high",
      caller_level: check.caller_level,
      required_level: check.required_level,
      affected_count: check.affected_count,
      strict_suppressed: false,
      typo_corrections: check.typo_corrections,
      warning_title: `高敏感字段权限不足（需 L${check.required_level} 级权限）`,
      warning_detail: `检测到当前输入触及 ${check.affected_count} 条高敏感度受控条款，你的当前身份为 ${identity.label}（L${check.caller_level}）。正式提交后服务端将自动拦截并记入合规审计流水；如需查阅完整细则，请联系具备 L${check.required_level} 权限的负责人或 HR。`,
    });
    return;
  }

  if (check.status === "partial_restricted") {
    res.json({
      status: "partial_restricted",
      risk_level: "medium",
      caller_level: check.caller_level,
      required_level: check.required_level,
      affected_count: check.affected_count,
      strict_suppressed: false,
      typo_corrections: check.typo_corrections,
      warning_title: `触及分级受控条款（含 L${check.required_level} 级管理细则）`,
      warning_detail: `当前问题关联的 ${check.affected_count} 条条款包含高于你权限级别（L${check.caller_level}）的内部细则。提交后系统仅返回公开层内容，高密级字段将在服务端自动截断并留痕。`,
    });
    return;
  }

  res.json({
    status: "clear",
    risk_level: "none",
    caller_level: check.caller_level,
    required_level: check.caller_level,
    affected_count: 0,
    strict_suppressed: false,
    typo_corrections: check.typo_corrections,
    warning_title: "",
    warning_detail: "",
  });
});

app.post("/api/ask", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const dataset = cleanString(body.dataset, 64);
  const question = cleanString(body.question, 1000);
  const requestedStrictMode = Boolean(body.strict_mode);
  const claimedRole = typeof body.role === "string" ? body.role : null;

  if (!dataset || !SLUG_RE.test(dataset) || !question) {
    res.status(422).json({ detail: "请提供有效的知识库与问题（1~1000 字）" });
    return;
  }

  const result = await executeGovernedAsk({
    dataset,
    question,
    requestedStrictMode,
    claimedRole,
    token: getApiToken(req),
    auditEvent: "ask",
    scope: "console",
  });

  if (result.httpStatus !== 200 || !result.payload) {
    res.status(result.httpStatus).json({ detail: result.errorDetail ?? "请求失败" });
    return;
  }

  res.json(result.payload);
});

// ---- 可插拔治理网关 API（供飞书机器人 / Dify / OpenAI SDK 直接接入） ----

app.post("/api/v1/gateway/govern", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const dataset = cleanString(body.dataset, 64);
  const question = cleanString(body.question, 1000);
  const requestedStrictMode = Boolean(body.strict_mode);

  if (!dataset || !SLUG_RE.test(dataset) || !question) {
    res.status(422).json({ detail: "请提供有效的 dataset 与 question（1~1000 字）" });
    return;
  }

  const result = await executeGovernedAsk({
    dataset,
    question,
    requestedStrictMode,
    claimedRole: null,
    token: getApiToken(req),
    auditEvent: "gateway_call",
    scope: "gateway_govern",
    skipLlmSynthesis: true,
  });

  if (result.httpStatus !== 200 || !result.payload) {
    res.status(result.httpStatus).json({
      audit_id: result.auditId,
      detail: result.errorDetail ?? "网关拦截",
    });
    return;
  }

  res.setHeader("X-GovLayer-Verdict", result.payload.verdict);
  res.setHeader("X-GovLayer-Audit-Id", result.payload.audit_id);
  res.json(result.payload);
});

app.post("/api/v1/chat/completions", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawModel = cleanString(body.model, 96) || "govlayer:employee_rules";
  const datasetFromModel = rawModel.startsWith("govlayer:")
    ? rawModel.slice("govlayer:".length)
    : "";
  const dataset = cleanString(body.dataset, 64) || datasetFromModel || "employee_rules";
  const strictMode = Boolean(body.strict_mode);

  const messages = Array.isArray(body.messages) ? body.messages : [];
  let question = "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (m && m.role === "user" && typeof m.content === "string" && m.content.trim()) {
      question = m.content.trim().slice(0, 1000);
      break;
    }
  }

  if (!SLUG_RE.test(dataset) || !question) {
    res.status(422).json({
      error: {
        message: "messages 中必须包含至少一条非空 user 消息，且 model 需指定 govlayer:<dataset_id>",
        type: "invalid_request_error",
      },
    });
    return;
  }

  const result = await executeGovernedAsk({
    dataset,
    question,
    requestedStrictMode: strictMode,
    claimedRole: null,
    token: getApiToken(req),
    auditEvent: "gateway_call",
    scope: "openai_proxy",
  });

  if (result.httpStatus !== 200 || !result.payload) {
    res.status(result.httpStatus).json({
      error: {
        message: result.errorDetail ?? "治理网关拒绝访问",
        type: result.httpStatus === 401 ? "authentication_error" : "permission_error",
        audit_id: result.auditId,
      },
    });
    return;
  }

  const p = result.payload;
  res.setHeader("X-GovLayer-Verdict", p.verdict);
  res.setHeader("X-GovLayer-Audit-Id", p.audit_id);
  res.json({
    id: `chatcmpl-${p.audit_id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: `govlayer:${p.dataset}`,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: p.answer_text,
        },
        finish_reason: "stop",
      },
    ],
    govlayer: {
      audit_id: p.audit_id,
      verdict: p.verdict,
      department: p.department,
      level: p.level,
      role: p.role,
      allowed_to_call_llm: p.allowed_to_call_llm,
      denied_fields: p.denied_fields,
      strict_mode: p.strict_mode,
      safe_context_len: p.safe_context.length,
    },
  });
});

// ---- 审计留痕与合规 CSV 导出 ----

app.get("/api/audit", (req: Request, res: Response) => {
  if (!requireAuditor(req, res, "audit")) return;
  const limit = Number(req.query.limit ?? 100);
  const event = typeof req.query.event === "string" && req.query.event ? req.query.event : null;
  res.json({
    records: AUDIT.tail(limit, event),
    stats: AUDIT.stats(),
  });
});

app.get("/api/audit/stats", (req: Request, res: Response) => {
  if (!requireAuditor(req, res, "audit")) return;
  res.json(AUDIT.stats());
});

app.get("/api/audit/export", (req: Request, res: Response) => {
  if (!requireAuditor(req, res, "audit_export")) return;
  const limit = Number(req.query.limit ?? 500);
  const event = typeof req.query.event === "string" && req.query.event ? req.query.event : null;
  const csv = AUDIT.toCsv(limit, event);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="govlayer-audit.csv"');
  res.send(csv);
});

// Serve built React frontend
app.use(express.static(CLIENT_DIST_DIR, { index: false }));

app.get("/{*splat}", (req: Request, res: Response) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ detail: "API endpoint not found" });
    return;
  }
  const indexPath = path.join(CLIENT_DIST_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
    return;
  }
  res
    .status(503)
    .type("text/plain")
    .send("Frontend bundle not built yet. Run `npm run build` first.");
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `GovLayer listening on http://0.0.0.0:${PORT} (${DATASETS.size} datasets, feishu=${getFeishuStatus().configured ? "configured" : "not_configured"})`
  );
});
