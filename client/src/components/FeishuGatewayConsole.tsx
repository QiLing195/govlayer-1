import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  CloudDownload,
  Copy,
  FileUp,
  Plug,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import type {
  DatasetMeta,
  FeishuStatus,
  FeishuWikiSpace,
  GatewayGovernResponse,
} from "../types.ts";

interface FeishuGatewayConsoleProps {
  token: string;
  datasets: DatasetMeta[];
  activeDatasetId: string;
  onDatasetSynced: (newDatasetId: string) => void;
}

type TabId = "feishu" | "gateway";

const SAMPLE_FEISHU_MARKDOWN = `# 差旅住宿与交通报销标准
关键词：差旅、住宿、报销、机票、高铁
[L0] 员工因公出差可报销经济舱机票或二等座高铁；一线城市住宿标准为 550 元/晚，其余城市为 400 元/晚，需凭合规增值税发票在返回后 7 个工作日内提交飞书审批。
[L1] 部门经理可在单次出差预算内行使不超过 20% 的弹性调剂权；若涉及客户陪同升级住宿，需在飞书审批流中附注客户名称与事由。
[L2] 针对总监及以上高管或涉密项目专项出差，财务与 HRBP 可启用不公开专项成本中心（CC-901）并豁免常规酒店星级限制；如发现虚开发票或替票行为，HR 将直接启动解除劳动合同程序。

# 内部转岗与职级晋升规则
关键词：转岗、晋升、调薪、绩效
[L0] 员工在当前岗位满 12 个月且最近两次绩效考核均为 B 及以上，可在飞书内推平台申请内部活水转岗。
[L1] 原部门主管不得无故阻拦符合条件的内部转岗，交接周期最长不超过 30 个自然日。
[L2] 跨序列晋升涉及薪酬带宽调整时，涨幅原则上控制在 8%~15%，特殊破格调薪须由薪酬委员会与 HRD 联合签批，具体薪酬分位表禁止向非 HR 人员披露。`;

export function FeishuGatewayConsole({
  token,
  datasets,
  activeDatasetId,
  onDatasetSynced,
}: FeishuGatewayConsoleProps) {
  const [tab, setTab] = useState<TabId>("feishu");
  const [status, setStatus] = useState<FeishuStatus | null>(null);
  const [spaces, setSpaces] = useState<FeishuWikiSpace[]>([]);
  const [loadingSpaces, setLoadingSpaces] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Live Feishu Wiki / Bitable sync form state
  const [syncMode, setSyncMode] = useState<"wiki" | "bitable">("wiki");
  const [spaceId, setSpaceId] = useState("");
  const [appToken, setAppToken] = useState("");
  const [tableId, setTableId] = useState("");
  const [syncDatasetId, setSyncDatasetId] = useState("feishu_wiki_kb");
  const [syncDisplayName, setSyncDisplayName] = useState("");
  const [syncing, setSyncing] = useState(false);

  // Structured Feishu Markdown import state
  const [importDatasetId, setImportDatasetId] = useState("feishu_policy_demo");
  const [importDisplayName, setImportDisplayName] = useState("飞书制度手册（差旅与晋升）");
  const [importMarkdown, setImportMarkdown] = useState("");
  const [importing, setImporting] = useState(false);

  // Gateway tester state
  const [gwDataset, setGwDataset] = useState(activeDatasetId || "employee_rules");
  const [gwQuestion, setGwQuestion] = useState("旷工超过多少天会被劝退？");
  const [gwStrict, setGwStrict] = useState(false);
  const [gwLoading, setGwLoading] = useState(false);
  const [gwResult, setGwResult] = useState<GatewayGovernResponse | null>(null);
  const [gwError, setGwError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    if (activeDatasetId && datasets.some((d) => d.id === activeDatasetId)) {
      setGwDataset(activeDatasetId);
    }
  }, [activeDatasetId, datasets]);

  const loadStatus = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/feishu/status", {
        headers: { "X-API-Token": token },
      });
      if (!res.ok) return;
      const json = (await res.json()) as FeishuStatus;
      setStatus(json);
      if (json.default_space_id) {
        setSpaceId((prev) => prev || json.default_space_id);
      }
    } catch {
      // ignore transient
    }
  }, [token]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function fetchWikiSpaces() {
    setLoadingSpaces(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/feishu/spaces", {
        headers: { "X-API-Token": token },
      });
      const json = (await res.json().catch(() => ({}))) as {
        detail?: string;
        spaces?: FeishuWikiSpace[];
      };
      if (!res.ok) {
        setError(`拉取飞书空间失败（HTTP ${res.status}）：${json.detail ?? "请检查配置"}`);
        return;
      }
      const list = json.spaces ?? [];
      setSpaces(list);
      if (list.length > 0 && !spaceId) {
        setSpaceId(list[0].space_id);
        setSyncDisplayName(list[0].name);
      }
      setNotice(`已从飞书开放平台拉取 ${list.length} 个知识空间，并同步组织架构部门清单。`);
    } finally {
      setLoadingSpaces(false);
    }
  }

  async function handleLiveSync(e: React.FormEvent) {
    e.preventDefault();
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const endpoint =
        syncMode === "wiki" ? "/api/feishu/sync/wiki" : "/api/feishu/sync/bitable";
      const payload =
        syncMode === "wiki"
          ? {
              space_id: spaceId.trim(),
              dataset_id: syncDatasetId.trim(),
              display_name: syncDisplayName.trim(),
            }
          : {
              app_token: appToken.trim(),
              table_id: tableId.trim(),
              dataset_id: syncDatasetId.trim(),
              display_name: syncDisplayName.trim(),
            };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Token": token,
        },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as {
        detail?: string;
        dataset?: DatasetMeta;
      };
      if (!res.ok || !json.dataset) {
        setError(`同步失败（HTTP ${res.status}）：${json.detail ?? "请检查飞书权限与参数"}`);
        return;
      }
      setNotice(
        `同步成功：已将「${json.dataset.name}」（共 ${json.dataset.n_objects} 条条款）热加载为受控知识库，并写入审计流水。`
      );
      onDatasetSynced(json.dataset.id);
    } finally {
      setSyncing(false);
    }
  }

  async function handleMarkdownImport(e: React.FormEvent) {
    e.preventDefault();
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/feishu/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Token": token,
        },
        body: JSON.stringify({
          dataset_id: importDatasetId.trim(),
          display_name: importDisplayName.trim(),
          markdown: importMarkdown,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        detail?: string;
        dataset?: DatasetMeta;
      };
      if (!res.ok || !json.dataset) {
        setError(`导入失败（HTTP ${res.status}）：${json.detail ?? "请检查身份权限与正文格式"}`);
        return;
      }
      setNotice(
        `导入成功：已解析并热加载「${json.dataset.name}」（${json.dataset.n_objects} 条分级条款），可直接切换左侧知识库验证 L0/L1/L2 字段级隔离。`
      );
      onDatasetSynced(json.dataset.id);
    } finally {
      setImporting(false);
    }
  }

  async function runGatewayTest(e: React.FormEvent) {
    e.preventDefault();
    if (!gwQuestion.trim()) return;
    setGwLoading(true);
    setGwError(null);
    try {
      const res = await fetch("/api/v1/gateway/govern", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          dataset: gwDataset,
          question: gwQuestion.trim(),
          strict_mode: gwStrict,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as GatewayGovernResponse & {
        detail?: string;
      };
      if (!res.ok) {
        setGwError(`网关拦截（HTTP ${res.status}）：${json.detail ?? "鉴权或策略未通过"}`);
        setGwResult(null);
        return;
      }
      setGwResult(json);
    } catch {
      setGwError("无法连接到治理网关接口");
      setGwResult(null);
    } finally {
      setGwLoading(false);
    }
  }

  function copyText(key: string, text: string) {
    void navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  }

  const origin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const canManage = Boolean(status?.can_manage);

  const governCurl = `curl -X POST "${origin}/api/v1/gateway/govern" \\
  -H "Authorization: Bearer <SERVER_ISSUED_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{"dataset":"${gwDataset}","question":"旷工超过多少天会被劝退？","strict_mode":false}'`;

  const openaiCurl = `curl -X POST "${origin}/api/v1/chat/completions" \\
  -H "Authorization: Bearer <SERVER_ISSUED_TOKEN>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"govlayer:${gwDataset}","messages":[{"role":"user","content":"公司上班和下班作息时间是几点？"}]}'`;

  return (
    <div className="space-y-5">
      {/* Header + Segmented Tabs */}
      <section className="rounded-lg border border-slate-200 bg-white px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              飞书数据源接入与可插拔治理网关
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              直接对接飞书知识空间（Wiki）、多维表格（Bitable）与分层文档，无需假数据库代理；
              并通过标准 HTTP / OpenAI 兼容网关嵌入飞书机器人、Dify 或现有企业 RAG 链路。
            </p>
          </div>
          <div className="inline-flex rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setTab("feishu")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                tab === "feishu"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <CloudDownload className="h-3.5 w-3.5" />
              <span>飞书数据源同步</span>
            </button>
            <button
              type="button"
              onClick={() => setTab("gateway")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                tab === "gateway"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              <Plug className="h-3.5 w-3.5" />
              <span>可插拔治理网关 API</span>
            </button>
          </div>
        </div>
      </section>

      {error && (
        <section className="rounded-lg border border-red-200 bg-red-50/70 px-4 py-3 text-xs text-red-800 flex items-start gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
          <span>{error}</span>
        </section>
      )}

      {notice && (
        <section className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-xs text-emerald-900">
          {notice}
        </section>
      )}

      {tab === "feishu" ? (
        <div className="space-y-5">
          {/* Server-Side Feishu Configuration Status (Read-Only, Zero Secret Inputs) */}
          <section className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  飞书开放平台服务端凭证状态
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  应用凭证严格通过服务端环境变量 <span className="font-mono">FEISHU_APP_ID</span> /{" "}
                  <span className="font-mono">FEISHU_APP_SECRET</span> 注入，前端永不收集或暴露密钥。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!canManage || !status?.configured || loadingSpaces}
                  onClick={() => void fetchWikiSpaces()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loadingSpaces ? "animate-spin" : ""}`} />
                  <span>拉取知识空间与部门</span>
                </button>
              </div>
            </div>

            <div className="grid gap-4 px-5 py-4 text-xs sm:grid-cols-3">
              <div>
                <div className="text-slate-500">连接状态</div>
                <div
                  className={`mt-1 font-semibold ${
                    status?.configured ? "text-emerald-700" : "text-amber-700"
                  }`}
                >
                  {status?.configured ? "服务端凭证已配置（可直连同步）" : "未配置服务端环境变量"}
                </div>
              </div>
              <div>
                <div className="text-slate-500">飞书网关域名（白名单锁定）</div>
                <div className="mt-1 font-mono text-slate-900">
                  {status?.domain ?? "https://open.feishu.cn"}
                </div>
              </div>
              <div>
                <div className="text-slate-500">App ID（脱敏）</div>
                <div className="mt-1 font-mono text-slate-900">
                  {status?.app_id_masked || "未设置"}
                </div>
              </div>
            </div>

            <div className="px-5 py-3 bg-slate-50/60 text-xs text-slate-600">
              飞书自建应用所需最小只读权限：
              <span className="ml-1 font-mono text-slate-800">wiki:wiki:readonly</span> ·{" "}
              <span className="font-mono text-slate-800">docx:document:readonly</span> ·{" "}
              <span className="font-mono text-slate-800">bitable:app:readonly</span> ·{" "}
              <span className="font-mono text-slate-800">contact:department.base:readonly</span>
            </div>
          </section>

          {/* Live Feishu Wiki / Bitable Sync Form */}
          <section className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  方式一：直连飞书开放平台同步
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  支持按飞书知识空间拉取 docx 原文（解析 <span className="font-mono">[L0]/[L1]/[L2]</span> 密级标记），或按飞书多维表格的分级列直接建库。
                </p>
              </div>
              <div className="inline-flex rounded-md bg-slate-100 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setSyncMode("wiki")}
                  className={`rounded px-2.5 py-1 font-medium ${
                    syncMode === "wiki" ? "bg-white text-slate-900 shadow-xs" : "text-slate-600"
                  }`}
                >
                  知识空间 (Wiki)
                </button>
                <button
                  type="button"
                  onClick={() => setSyncMode("bitable")}
                  className={`rounded px-2.5 py-1 font-medium ${
                    syncMode === "bitable" ? "bg-white text-slate-900 shadow-xs" : "text-slate-600"
                  }`}
                >
                  多维表格 (Bitable)
                </button>
              </div>
            </div>

            {spaces.length > 0 && syncMode === "wiki" && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-500">已发现的知识空间：</span>
                {spaces.map((sp) => (
                  <button
                    key={sp.space_id}
                    type="button"
                    onClick={() => {
                      setSpaceId(sp.space_id);
                      setSyncDisplayName(sp.name);
                    }}
                    className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-slate-700 hover:bg-slate-100"
                  >
                    {sp.name} <span className="font-mono text-slate-400">({sp.space_id})</span>
                  </button>
                ))}
              </div>
            )}

            <form onSubmit={(e) => void handleLiveSync(e)} className="grid gap-3 sm:grid-cols-2">
              {syncMode === "wiki" ? (
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    飞书知识空间 ID（space_id）
                  </label>
                  <input
                    type="text"
                    required
                    value={spaceId}
                    onChange={(e) => setSpaceId(e.target.value)}
                    placeholder="例如：7291048572910485729"
                    className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-xs font-mono focus:border-blue-600 focus:outline-none"
                  />
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      多维表格 app_token
                    </label>
                    <input
                      type="text"
                      required
                      value={appToken}
                      onChange={(e) => setAppToken(e.target.value)}
                      placeholder="例如：bascnCMII2ORej2RItqpZZUNVox"
                      className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-xs font-mono focus:border-blue-600 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      数据表 table_id
                    </label>
                    <input
                      type="text"
                      required
                      value={tableId}
                      onChange={(e) => setTableId(e.target.value)}
                      placeholder="例如：tblxI2tWaxP5dG7p"
                      className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-xs font-mono focus:border-blue-600 focus:outline-none"
                    />
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700">
                  目标知识库标识（英文/数字/下划线）
                </label>
                <input
                  type="text"
                  required
                  value={syncDatasetId}
                  onChange={(e) => setSyncDatasetId(e.target.value)}
                  placeholder="feishu_hr_wiki"
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-xs font-mono focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700">
                  显示名称（可选）
                </label>
                <input
                  type="text"
                  value={syncDisplayName}
                  onChange={(e) => setSyncDisplayName(e.target.value)}
                  placeholder="例如：飞书人力资源制度库"
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-xs focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2 pt-1">
                <span className="text-xs text-slate-500">
                  {!canManage
                    ? "需切换至 L2 HR / 合规审计员令牌后执行同步"
                    : !status?.configured
                    ? "服务端配置 FEISHU_APP_ID / FEISHU_APP_SECRET 后可启用直连同步"
                    : "同步完成后自动落盘 data/gov_<id>.json 并热加载至治理引擎"}
                </span>
                <button
                  type="submit"
                  disabled={!canManage || !status?.configured || syncing}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-blue-700 px-4 text-xs font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
                >
                  <CloudDownload className="h-3.5 w-3.5" />
                  <span>{syncing ? "正在同步飞书..." : "立即从飞书同步"}</span>
                </button>
              </div>
            </form>
          </section>

          {/* Structured Feishu Markdown Tiered Import (Works Immediately for L2) */}
          <section className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  方式二：导入飞书导出的分层 Markdown 文档（即时体验）
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  将飞书云文档导出为 Markdown，在段落前标注{" "}
                  <span className="font-mono">[L0]</span>（全员）、
                  <span className="font-mono">[L1]</span>（主管）或{" "}
                  <span className="font-mono">[L2]</span>（HR/审计），一键热加载为受控知识库。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setImportMarkdown(SAMPLE_FEISHU_MARKDOWN)}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                填入飞书制度示例
              </button>
            </div>

            <form onSubmit={(e) => void handleMarkdownImport(e)} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    知识库标识
                  </label>
                  <input
                    type="text"
                    required
                    value={importDatasetId}
                    onChange={(e) => setImportDatasetId(e.target.value)}
                    className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-xs font-mono focus:border-blue-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">
                    知识库名称
                  </label>
                  <input
                    type="text"
                    required
                    value={importDisplayName}
                    onChange={(e) => setImportDisplayName(e.target.value)}
                    className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-xs focus:border-blue-600 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700">
                  飞书文档正文（按 # 标题分条，支持 [L0] / [L1] / [L2] 密级标签）
                </label>
                <textarea
                  required
                  rows={8}
                  value={importMarkdown}
                  onChange={(e) => setImportMarkdown(e.target.value)}
                  placeholder="# 条款标题&#10;[L0] 全员可见的公开制度说明&#10;[L1] 部门主管可见的审批口径&#10;[L2] 仅 HR / 审计可见的红线细则"
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white p-3 font-mono text-xs leading-relaxed text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-slate-500">
                  {canManage
                    ? "导入后立即出现在左侧知识库列表，可配合 ABAC 部门边界联合管控"
                    : "仅 L2 HR / 合规审计员可执行知识库导入"}
                </span>
                <button
                  type="submit"
                  disabled={!canManage || importing || !importMarkdown.trim()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-blue-700 px-4 text-xs font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
                >
                  <FileUp className="h-3.5 w-3.5" />
                  <span>{importing ? "解析并热加载中..." : "解析并导入为受控知识库"}</span>
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Interactive Pluggable Gateway Tester */}
          <section className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                实时治理网关调试台（POST /api/v1/gateway/govern）
              </h3>
              <p className="mt-0.5 text-xs text-slate-500">
                使用当前选中的令牌以标准 <span className="font-mono">Authorization: Bearer</span>{" "}
                头调用治理网关，返回确定性判定、是否允许触发下游大模型（
                <span className="font-mono">allowed_to_call_llm</span>）与已裁剪的安全上下文（
                <span className="font-mono">safe_context</span>）。
              </p>
            </div>

            <form onSubmit={(e) => void runGatewayTest(e)} className="grid gap-3 sm:grid-cols-12">
              <div className="sm:col-span-3">
                <label className="block text-xs font-medium text-slate-700">目标知识库</label>
                <select
                  value={gwDataset}
                  onChange={(e) => setGwDataset(e.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-xs text-slate-900"
                >
                  {datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.id})
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-7">
                <label className="block text-xs font-medium text-slate-700">测试提问</label>
                <input
                  type="text"
                  required
                  value={gwQuestion}
                  onChange={(e) => setGwQuestion(e.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div className="sm:col-span-2 flex items-end">
                <button
                  type="submit"
                  disabled={gwLoading}
                  className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-blue-700 px-3 text-xs font-medium text-white hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap"
                >
                  <span>{gwLoading ? "调用中..." : "执行网关"}</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="sm:col-span-12">
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={gwStrict}
                    onChange={(e) => setGwStrict(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-slate-300 text-blue-700"
                  />
                  <span>启用严格隔离模式（strict_mode: true）</span>
                </label>
              </div>
            </form>

            {gwError && (
              <div className="rounded-md border border-red-200 bg-red-50/70 px-3.5 py-2.5 text-xs text-red-800">
                {gwError}
              </div>
            )}

            {gwResult && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono font-semibold text-slate-900">
                      verdict={gwResult.verdict}
                    </span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span
                      className={
                        gwResult.allowed_to_call_llm
                          ? "font-medium text-emerald-700"
                          : "font-medium text-red-700"
                      }
                    >
                      allowed_to_call_llm={String(gwResult.allowed_to_call_llm)}
                    </span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="font-mono text-slate-600">{gwResult.audit_id}</span>
                  </div>
                  <span className="font-mono tabular-nums text-slate-500">
                    {gwResult.latency_ms} ms
                  </span>
                </div>
                <pre className="max-h-72 overflow-auto rounded-md border border-slate-200 bg-white p-3 font-mono text-[11px] leading-relaxed text-slate-800">
                  {JSON.stringify(
                    {
                      audit_id: gwResult.audit_id,
                      verdict: gwResult.verdict,
                      identity: gwResult.identity,
                      allowed_to_call_llm: gwResult.allowed_to_call_llm,
                      denied_fields: gwResult.denied_fields,
                      safe_context: gwResult.safe_context,
                      boundary_note: gwResult.boundary_note,
                    },
                    null,
                    2
                  )}
                </pre>
              </div>
            )}
          </section>

          {/* Integration Snippets */}
          <section className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold text-slate-900">
                  飞书机器人 / Dify 前置治理接口
                </h4>
                <button
                  type="button"
                  onClick={() => copyText("govern", governCurl)}
                  className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
                >
                  {copiedKey === "govern" ? (
                    <Check className="h-3 w-3 text-emerald-600" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  <span>{copiedKey === "govern" ? "已复制" : "复制 cURL"}</span>
                </button>
              </div>
              <p className="text-xs text-slate-500">
                在调用企业大模型前先过一次 GovLayer：仅当{" "}
                <span className="font-mono">allowed_to_call_llm=true</span> 时将{" "}
                <span className="font-mono">safe_context</span> 喂给模型。
              </p>
              <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
                {governCurl}
              </pre>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold text-slate-900">
                  OpenAI 兼容治理代理接口
                </h4>
                <button
                  type="button"
                  onClick={() => copyText("openai", openaiCurl)}
                  className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
                >
                  {copiedKey === "openai" ? (
                    <Check className="h-3 w-3 text-emerald-600" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  <span>{copiedKey === "openai" ? "已复制" : "复制 cURL"}</span>
                </button>
              </div>
              <p className="text-xs text-slate-500">
                兼容标准 OpenAI SDK，将 <span className="font-mono">baseURL</span> 指向{" "}
                <span className="font-mono">{origin}/api/v1</span>，模型填写{" "}
                <span className="font-mono">govlayer:&lt;dataset_id&gt;</span>。
              </p>
              <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
                {openaiCurl}
              </pre>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
