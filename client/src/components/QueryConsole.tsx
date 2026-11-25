import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Lock,
  Plus,
  RefreshCw,
  ScanSearch,
  Search,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import type {
  AskResponse,
  DatasetMeta,
  PreflightResponse,
  RiskFindingSeverity,
  RiskScanResponse,
  Verdict,
} from "../types.ts";

interface QueryConsoleProps {
  dataset: DatasetMeta;
  token: string;
  activeLevel: number;
  onPrecedentCreated: () => void;
}

const AUTHORITY_TEXT: Record<string, string> = {
  customer: "客户确认的真实权限边界",
  standard: "公开标准 / 法规条文",
  proposed: "提议值（未经业务确认）",
  unlabeled: "未声明分层来源",
};

const VERDICT_META: Record<
  Verdict,
  { label: string; colorClass: string; desc: string }
> = {
  covered: {
    label: "明文可答",
    colorClass: "text-emerald-700",
    desc: "命中条款在当前权限范围内已覆盖该问题",
  },
  restricted: {
    label: "权限受限",
    colorClass: "text-red-700",
    desc: "制度中存在相关高密级条款，但超出当前身份权限已硬截断",
  },
  gap: {
    label: "制度空白 · 需人工升级",
    colorClass: "text-amber-700",
    desc: "命中相关主题但制度未覆盖该情形，系统不编造规则",
  },
  out_of_scope: {
    label: "范围外",
    colorClass: "text-slate-700",
    desc: "当前知识库中无对应条款",
  },
};

const RETRIEVAL_LABEL: Record<string, string> = {
  keyword: "确定性关键词检索",
  hybrid: "关键词与词组混合检索",
  llm: "LLM 语义检索",
};

export function QueryConsole({
  dataset,
  token,
  activeLevel,
  onPrecedentCreated,
}: QueryConsoleProps) {
  const [question, setQuestion] = useState("");
  const [strictMode, setStrictMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResponse | null>(null);

  // Inline precedent capture for L2 HR/Auditors on gap/out_of_scope verdicts
  const [showRecordForm, setShowRecordForm] = useState(false);
  const [rulingTopic, setRulingTopic] = useState("");
  const [rulingText, setRulingText] = useState("");
  const [rulingReason, setRulingReason] = useState("");
  const [rulingApprover, setRulingApprover] = useState("");
  const [savingPrecedent, setSavingPrecedent] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  // Real-time server-side compliance preflight (never exposes restricted clause content)
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [checkingPreflight, setCheckingPreflight] = useState(false);

  // Full-library compliance risk scan sidebar state
  const [scanOpen, setScanOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanData, setScanData] = useState<RiskScanResponse | null>(null);
  const [scanFilter, setScanFilter] = useState<"all" | RiskFindingSeverity>("all");

  async function runRiskScan() {
    setScanOpen(true);
    setScanning(true);
    setScanError(null);
    try {
      const res = await fetch(
        `/api/datasets/${encodeURIComponent(dataset.id)}/risk-scan`,
        {
          method: "POST",
          headers: {
            ...(token ? { "X-API-Token": token } : {}),
          },
        }
      );
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string };
        setScanError(
          `全库扫描被拒绝（HTTP ${res.status}）：${d.detail ?? "请检查身份令牌与知识库访问策略"}`
        );
        setScanData(null);
        return;
      }
      const json = (await res.json()) as RiskScanResponse;
      setScanData(json);
    } catch {
      setScanError("无法连接到治理扫描服务，请稍后重试。");
      setScanData(null);
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    const trimmed = question.trim();
    if (!token || trimmed.length < 2) {
      setPreflight(null);
      setCheckingPreflight(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setCheckingPreflight(true);
      try {
        const res = await fetch("/api/preflight", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Token": token,
          },
          body: JSON.stringify({
            dataset: dataset.id,
            question: trimmed,
            strict_mode: strictMode,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          setPreflight(null);
          return;
        }
        const data = (await res.json()) as PreflightResponse;
        setPreflight(data);
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") {
          setPreflight(null);
        }
      } finally {
        if (!controller.signal.aborted) {
          setCheckingPreflight(false);
        }
      }
    }, 240);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [dataset.id, question, strictMode, token]);

  async function runQuery(qText?: string) {
    const query = (qText ?? question).trim();
    if (!query) return;
    if (qText !== undefined) {
      setQuestion(qText);
    }
    setLoading(true);
    setError(null);
    setSaveNotice(null);
    setShowRecordForm(false);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-API-Token": token } : {}),
        },
        body: JSON.stringify({
          dataset: dataset.id,
          question: query,
          strict_mode: strictMode,
        }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { detail?: string };
        setError(`请求被拒绝（HTTP ${res.status}）：${detail.detail ?? "请检查身份令牌"}`);
        setResult(null);
        return;
      }
      const data = (await res.json()) as AskResponse;
      setResult(data);
    } catch {
      setError("无法连接到治理服务，请稍后重试。");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  async function submitPrecedent(e: React.FormEvent) {
    e.preventDefault();
    if (!result || !rulingTopic.trim() || !rulingText.trim()) return;
    setSavingPrecedent(true);
    setSaveNotice(null);
    try {
      const res = await fetch("/api/precedents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Token": token,
        },
        body: JSON.stringify({
          dataset: dataset.id,
          topic: rulingTopic.trim(),
          question: result.question,
          context: "治理台空白升级裁决",
          ruling: rulingText.trim(),
          reasoning: rulingReason.trim(),
          approver: rulingApprover.trim() || "HR / 合规审计员",
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string };
        setSaveNotice(`登记失败（${res.status}）：${d.detail ?? "权限不足"}`);
        return;
      }
      const created = (await res.json()) as { case_id: string };
      setSaveNotice(`已沉淀为先例 ${created.case_id} 并写入审计日志。再次提问同类问题时将自动展示参考先例。`);
      setShowRecordForm(false);
      setRulingTopic("");
      setRulingText("");
      setRulingReason("");
      onPrecedentCreated();
    } finally {
      setSavingPrecedent(false);
    }
  }

  const pm = dataset.permission_model;
  const maxDatasetLevel = Math.max(...Object.values(dataset.roles), 0);
  const canRecordPrecedent = activeLevel >= 2;
  const verdictInfo = result ? VERDICT_META[result.verdict] : null;

  return (
    <div className="space-y-6">
      {/* Dataset Provenance & Honesty Disclosure */}
      <section className="rounded-lg border border-slate-200 bg-white px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900">{dataset.name}</h2>
            <p className="mt-1 text-sm text-slate-600">{dataset.description}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <div className="flex items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
              <span>{dataset.n_objects} 条条款</span>
              <span aria-hidden="true">·</span>
              <span>{dataset.n_cases} 条先例</span>
              <span aria-hidden="true">·</span>
              <span>最高密级 L{maxDatasetLevel}</span>
            </div>
            <button
              type="button"
              onClick={() => void runRiskScan()}
              disabled={scanning}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-800 transition-colors hover:border-blue-300 hover:bg-blue-50/60 hover:text-blue-800 disabled:opacity-50 whitespace-nowrap"
            >
              <ScanSearch className={`h-3.5 w-3.5 ${scanning ? "animate-pulse" : ""}`} />
              <span>{scanning ? "全库扫描中..." : "一键全库风险扫描"}</span>
            </button>
          </div>
        </div>
        <div className="mt-3 border-t border-slate-100 pt-3 text-xs leading-relaxed text-slate-600 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={
                pm.may_claim_verified
                  ? "font-semibold text-emerald-700"
                  : "font-semibold text-amber-700"
              }
            >
              分层来源：{AUTHORITY_TEXT[pm.authority] ?? pm.authority}
            </span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span>{pm.source}</span>
          </div>
          {pm.principle && <p className="text-slate-500">分层原则：{pm.principle}</p>}
          {pm.warning && <p className="text-amber-800">{pm.warning}</p>}
          {dataset.policy && (
            <div className="pt-1 flex flex-wrap items-center gap-2 text-slate-500">
              <span className="font-medium text-slate-700">当前准入策略：</span>
              <span className={dataset.policy.enabled ? "text-emerald-700" : "text-red-700 font-medium"}>
                {dataset.policy.enabled ? "已启用" : "已停用"}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">最低级别 L{dataset.policy.min_level}</span>
              <span aria-hidden="true">·</span>
              <span>
                部门边界：
                {dataset.policy.allowed_departments &&
                dataset.policy.allowed_departments.length > 0
                  ? dataset.policy.allowed_departments.join("、")
                  : "全部门开放"}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {dataset.source_type === "feishu_wiki"
                  ? "来源：飞书知识空间"
                  : dataset.source_type === "feishu_bitable"
                  ? "来源：飞书多维表格"
                  : dataset.source_type === "feishu_doc"
                  ? "来源：飞书分层文档"
                  : "来源：内置语料"}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {dataset.policy.default_strict_mode ? "强制严格隔离" : "标准隔离"}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {dataset.policy.allow_llm ? "允许 LLM 整理" : "禁止外发 LLM"}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Query Composer */}
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runQuery();
          }}
          className="space-y-4"
        >
          <div>
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="gov-question-input"
                className="block text-sm font-medium text-slate-800"
              >
                制度合规提问
              </label>
              {checkingPreflight && (
                <span className="text-[11px] text-slate-400">实时合规预检中...</span>
              )}
            </div>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="gov-question-input"
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  maxLength={1000}
                  placeholder="输入制度或流程问题，例如：旷工超过多少天会被劝退？"
                  className={`h-11 w-full rounded-lg border bg-white pl-10 pr-4 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 ${
                    preflight?.risk_level === "high"
                      ? "border-red-400 focus:border-red-500 focus:ring-red-500/20"
                      : preflight?.risk_level === "medium"
                      ? "border-amber-400 focus:border-amber-500 focus:ring-amber-500/20"
                      : "border-slate-300 focus:border-blue-600 focus:ring-blue-600/20"
                  }`}
                />
              </div>
              <button
                type="submit"
                disabled={loading || !question.trim()}
                className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-blue-700 px-5 text-sm font-medium text-white transition-colors hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
              >
                <span>{loading ? "治理判定中..." : "提交判定"}</span>
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>

            {/* Real-time Compliance Preflight Warning */}
            {preflight &&
              (preflight.status === "restricted" || preflight.status === "blocked") && (
                <div
                  role="alert"
                  aria-live="polite"
                  className="mt-3 flex items-start gap-2.5 rounded-md border border-red-200 bg-red-50/70 px-3.5 py-2.5 text-xs text-red-900"
                >
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-semibold text-red-800">
                        合规预警：{preflight.warning_title}
                      </span>
                      <span aria-hidden="true" className="text-red-300">
                        ·
                      </span>
                      <span className="font-mono tabular-nums text-red-700">
                        当前 L{preflight.caller_level} / 需 L{preflight.required_level}
                      </span>
                      {preflight.affected_count > 0 && (
                        <>
                          <span aria-hidden="true" className="text-red-300">
                            ·
                          </span>
                          <span className="font-mono tabular-nums text-red-700">
                            涉及 {preflight.affected_count} 条受控条款
                          </span>
                        </>
                      )}
                    </div>
                    <p className="leading-relaxed text-red-800/90">
                      {preflight.warning_detail}
                    </p>
                    {preflight.typo_corrections.length > 0 && (
                      <p className="text-[11px] text-red-700">
                        预检已识别错别字：{preflight.typo_corrections.join("、")}
                      </p>
                    )}
                  </div>
                </div>
              )}

            {preflight && preflight.status === "partial_restricted" && (
              <div
                role="status"
                aria-live="polite"
                className="mt-3 flex items-start gap-2.5 rounded-md border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs text-amber-900"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-semibold text-amber-900">
                      合规提示：{preflight.warning_title}
                    </span>
                    <span aria-hidden="true" className="text-amber-300">
                      ·
                    </span>
                    <span className="font-mono tabular-nums text-amber-800">
                      当前 L{preflight.caller_level} / 含 L{preflight.required_level} 细则
                    </span>
                  </div>
                  <p className="leading-relaxed text-amber-800">
                    {preflight.warning_detail}
                  </p>
                </div>
              </div>
            )}

            {preflight && preflight.status === "strict_suppressed" && (
              <p className="mt-2.5 text-[11px] text-slate-500">
                严格隔离模式已启用：输入阶段不探测高密级条款是否存在，提交后仅在当前权限分区内检索。
              </p>
            )}

            {preflight &&
              preflight.status === "clear" &&
              preflight.typo_corrections.length > 0 && (
                <p className="mt-2.5 text-[11px] text-blue-700">
                  输入预检已识别制度用词纠错：{preflight.typo_corrections.join("、")}
                </p>
              )}
          </div>

          {/* Controls row: strict isolation toggle + quick scenario prompts */}
          <div className="flex flex-col gap-3 border-t border-slate-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <label className="inline-flex cursor-pointer items-center gap-2.5 text-xs text-slate-700 select-none">
              <input
                type="checkbox"
                checked={strictMode}
                onChange={(e) => setStrictMode(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
              />
              <span>
                严格隔离模式（检索阶段不触碰高密级索引，连“条款是否存在”也不披露）
              </span>
            </label>
            <span className="text-xs text-slate-500">
              身份由服务端令牌解析，客户端无法伪造角色
            </span>
          </div>

          {dataset.sample_questions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs text-slate-500">快速验证场景：</span>
              {dataset.sample_questions.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => void runQuery(s.question)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-100 hover:text-slate-900 whitespace-nowrap"
                >
                  <span>{s.label}</span>
                  <span className="text-slate-400 font-normal">· {s.intent}</span>
                </button>
              ))}
            </div>
          )}
        </form>
      </section>

      {/* Error State */}
      {error && (
        <section className="rounded-lg border border-red-200 bg-red-50/70 p-4 text-sm text-red-800">
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
            <p>{error}</p>
          </div>
        </section>
      )}

      {/* Save Precedent Feedback */}
      {saveNotice && (
        <section className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-900">
          {saveNotice}
        </section>
      )}

      {/* Loading Skeleton */}
      {loading && (
        <section className="rounded-lg border border-slate-200 bg-white p-6 space-y-4">
          <div className="h-4 w-48 animate-pulse rounded bg-slate-200" />
          <div className="h-16 w-full animate-pulse rounded bg-slate-100" />
          <div className="h-12 w-3/4 animate-pulse rounded bg-slate-100" />
        </section>
      )}

      {/* Result Panel */}
      {!loading && result && verdictInfo && (
        <section className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-200">
          {/* Header metadata line — zero pills, crisp unboxed typography */}
          <div className="px-6 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className={`text-base font-semibold ${verdictInfo.colorClass}`}>
                  {verdictInfo.label}
                </span>
                <span aria-hidden="true" className="text-slate-300">
                  ·
                </span>
                <span className="text-sm text-slate-600">{verdictInfo.desc}</span>
              </div>
              <div className="text-xs text-slate-500 font-mono tabular-nums">
                {result.latency_ms} ms
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <span>{result.identity}</span>
              <span aria-hidden="true">·</span>
              <span>{RETRIEVAL_LABEL[result.retrieval_mode] ?? result.retrieval_mode}</span>
              <span aria-hidden="true">·</span>
              <span>{result.llm_used ? "LLM 自然语言整理" : "条款原文直出"}</span>
              {result.strict_mode && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-medium text-slate-700">严格隔离模式</span>
                </>
              )}
            </div>
            {result.typo_corrections.length > 0 && (
              <p className="mt-2 text-xs text-blue-700">
                已自动纠错（审计可溯源）：{result.typo_corrections.join("、")}
              </p>
            )}
          </div>

          {/* Primary Answer */}
          <div className="px-6 py-5">
            <h3 className="text-xs font-medium text-slate-500">治理输出</h3>
            <p className="mt-2 whitespace-pre-wrap text-[15px] leading-relaxed text-slate-900">
              {result.answer_text}
            </p>
            {result.boundary_note && result.boundary_note !== result.answer_text && (
              <p className="mt-3 text-xs leading-relaxed text-amber-800">
                边界声明：{result.boundary_note}
              </p>
            )}
          </div>

          {/* Permission-Filtered Sources */}
          <div className="px-6 py-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium text-slate-500">
                命中依据（服务端按权限裁剪后）
              </h3>
              <span className="text-xs text-slate-400 font-mono tabular-nums">
                {result.visible_sources.length} 条命中
              </span>
            </div>

            {result.visible_sources.length === 0 ? (
              <p className="text-sm text-slate-500">当前权限范围内无匹配条款。</p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-slate-50/50">
                {result.visible_sources.map((src) => (
                  <div key={src.id} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-slate-900">
                        《{src.title}》
                      </span>
                      <span className="text-xs text-slate-400 font-mono">{src.id}</span>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                      {src.content}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {result.denied_fields.length > 0 && (
              <div className="flex items-start gap-2.5 rounded-md border border-red-200 bg-red-50/60 px-4 py-3 text-xs text-red-800">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-700" />
                <div>
                  <span className="font-semibold">高密级字段已截断：</span>
                  条目{" "}
                  <span className="font-mono">{result.denied_fields.join(", ")}</span>{" "}
                  包含高于当前身份级别（L{result.level}）的管理或处置细则，已在服务端剔除，未进入响应体与模型上下文。
                </div>
              </div>
            )}
          </div>

          {/* Precedents & Human Ruling Escalation */}
          {(result.precedents.length > 0 ||
            result.verdict === "gap" ||
            result.verdict === "out_of_scope") && (
            <div className="px-6 py-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-medium text-slate-500">
                  过往裁决先例与人工升级
                </h3>
                {(result.verdict === "gap" || result.verdict === "out_of_scope") &&
                  canRecordPrecedent &&
                  !showRecordForm && (
                    <button
                      type="button"
                      onClick={() => {
                        setShowRecordForm(true);
                        setRulingTopic(result.question.slice(0, 20));
                      }}
                      className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-800 transition-colors hover:bg-blue-100 whitespace-nowrap"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>沉淀为人工先例</span>
                    </button>
                  )}
              </div>

              {result.precedents.length > 0 ? (
                <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
                  {result.precedents.map((p) => (
                    <div key={p.case_id} className="px-4 py-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span className="font-mono font-medium text-slate-900">
                          {p.case_id}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{p.date}</span>
                        <span aria-hidden="true">·</span>
                        <span>审批人：{p.approver}</span>
                        <span aria-hidden="true">·</span>
                        <span className="text-amber-700">仅供参考，以实际确认为准</span>
                      </div>
                      <p className="mt-1.5 text-slate-900">{p.ruling}</p>
                      {p.reasoning && (
                        <p className="mt-1 text-xs text-slate-600">
                          裁决依据：{p.reasoning}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  暂无相关历史先例。
                  {!canRecordPrecedent &&
                    "（切换至 L2 HR / 合规审计员身份后可直接登记人工裁决并沉淀为先例）"}
                </p>
              )}

              {showRecordForm && (
                <form
                  onSubmit={(e) => void submitPrecedent(e)}
                  className="rounded-md border border-slate-200 bg-slate-50 p-4 space-y-3"
                >
                  <div className="text-sm font-medium text-slate-900">
                    登记人工裁决先例（仅 L2 审计/HR 权限）
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-medium text-slate-700">
                        议题标签
                      </label>
                      <input
                        type="text"
                        required
                        maxLength={80}
                        value={rulingTopic}
                        onChange={(e) => setRulingTopic(e.target.value)}
                        className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:border-blue-600 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700">
                        裁决审批人
                      </label>
                      <input
                        type="text"
                        maxLength={80}
                        placeholder="例如：HR 总监"
                        value={rulingApprover}
                        onChange={(e) => setRulingApprover(e.target.value)}
                        className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:border-blue-600 focus:outline-none"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      裁决结论
                    </label>
                    <textarea
                      required
                      rows={2}
                      maxLength={1000}
                      value={rulingText}
                      onChange={(e) => setRulingText(e.target.value)}
                      placeholder="写明本次人工裁决的处理标准..."
                      className="mt-1 w-full rounded-md border border-slate-300 bg-white p-2.5 text-sm focus:border-blue-600 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      裁决理由（可选）
                    </label>
                    <input
                      type="text"
                      maxLength={1000}
                      value={rulingReason}
                      onChange={(e) => setRulingReason(e.target.value)}
                      placeholder="例如：参照相近条款原则处理"
                      className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:border-blue-600 focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setShowRecordForm(false)}
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      disabled={savingPrecedent}
                      className="rounded-md bg-blue-700 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-800 disabled:opacity-50"
                    >
                      {savingPrecedent ? "保存中..." : "确认沉淀"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </section>
      )}

      {/* Empty Initial State */}
      {!loading && !result && !error && (
        <section className="rounded-lg border border-slate-200 bg-white px-6 py-10 text-center">
          <BookOpen className="mx-auto h-7 w-7 text-slate-400" />
          <h3 className="mt-3 text-sm font-semibold text-slate-900">
            在上方输入问题或点击快速验证场景
          </h3>
          <p className="mx-auto mt-1.5 max-w-lg text-xs leading-relaxed text-slate-500">
            尝试切换左侧不同权限令牌（L0 普通员工 / L1 部门经理 / L2 HR 审计员）提出同一个问题，或点击右上角「一键全库风险扫描」核查疑似越界条款。
          </p>
        </section>
      )}

      {/* Right-Hand Full-Library Risk Scan Sidebar Drawer */}
      {scanOpen && (
        <div
          className="fixed inset-0 z-50 flex justify-end"
          role="dialog"
          aria-modal="true"
          aria-label="全库合规风险扫描侧边栏"
        >
          <div
            className="fixed inset-0 bg-slate-900/25 transition-opacity"
            onClick={() => setScanOpen(false)}
          />
          <aside className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-xl">
            {/* Sidebar Header */}
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <ScanSearch className="h-4 w-4 shrink-0 text-blue-700" />
                  <h3 className="truncate text-sm font-semibold text-slate-900">
                    全库合规风险扫描
                  </h3>
                </div>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  {dataset.name} · 对比权限分层与准入边界
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => void runRiskScan()}
                  disabled={scanning}
                  aria-label="重新扫描"
                  title="重新扫描"
                  className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
                >
                  <RefreshCw className={`h-4 w-4 ${scanning ? "animate-spin" : ""}`} />
                </button>
                <button
                  type="button"
                  onClick={() => setScanOpen(false)}
                  aria-label="关闭扫描侧边栏"
                  className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Sidebar Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {scanning ? (
                <div className="space-y-3">
                  <div className="h-20 animate-pulse rounded-lg bg-slate-100" />
                  <div className="h-28 animate-pulse rounded-lg bg-slate-100" />
                  <div className="h-28 animate-pulse rounded-lg bg-slate-100" />
                </div>
              ) : scanError ? (
                <div className="rounded-lg border border-red-200 bg-red-50/70 p-4 text-xs text-red-800 flex items-start gap-2">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
                  <span>{scanError}</span>
                </div>
              ) : scanData ? (
                <>
                  {/* Summary Metrics */}
                  <div className="grid grid-cols-3 gap-2.5">
                    <div className="rounded-md border border-slate-200 bg-slate-50/70 px-3 py-2.5">
                      <div className="text-[11px] text-slate-500">合规得分</div>
                      <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-slate-900">
                        {scanData.report.compliance_score}
                        <span className="ml-0.5 text-[11px] font-normal text-slate-400">
                          /100
                        </span>
                      </div>
                    </div>
                    <div className="rounded-md border border-slate-200 bg-slate-50/70 px-3 py-2.5">
                      <div className="text-[11px] text-slate-500">疑似违规条目</div>
                      <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-amber-700">
                        {scanData.report.flagged_clauses}
                        <span className="ml-0.5 text-[11px] font-normal text-slate-400">
                          /{scanData.report.total_clauses}
                        </span>
                      </div>
                    </div>
                    <div className="rounded-md border border-slate-200 bg-slate-50/70 px-3 py-2.5">
                      <div className="text-[11px] text-slate-500">高风险预警</div>
                      <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-red-700">
                        {scanData.report.high_count}
                      </div>
                    </div>
                  </div>

                  {/* Active Boundary Context */}
                  <div className="rounded-md border border-slate-200 bg-slate-50/50 px-3.5 py-2.5 text-[11px] text-slate-600 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span>扫描身份：{scanData.identity}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-slate-500">
                      <span>
                        策略：L{scanData.report.policy_snapshot.min_level}+ ·{" "}
                        {scanData.report.policy_snapshot.default_strict_mode
                          ? "强制严格隔离"
                          : "标准隔离"}{" "}
                        ·{" "}
                        {scanData.report.policy_snapshot.allow_llm
                          ? "允许外发LLM"
                          : "禁止外发LLM"}
                      </span>
                    </div>
                  </div>

                  {/* Severity Filter */}
                  <div className="inline-flex w-full items-center gap-1 rounded-lg bg-slate-100 p-1">
                    {(
                      [
                        ["all", `全部 (${scanData.report.total_findings})`],
                        ["high", `高风险 (${scanData.report.high_count})`],
                        ["medium", `中风险 (${scanData.report.medium_count})`],
                        ["low", `低风险 (${scanData.report.low_count})`],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setScanFilter(key)}
                        className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                          scanFilter === key
                            ? "bg-white text-slate-900 shadow-xs"
                            : "text-slate-600 hover:text-slate-900"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {/* Findings List */}
                  {(() => {
                    const visibleFindings = scanData.report.findings.filter((f) =>
                      scanFilter === "all" ? true : f.severity === scanFilter
                    );
                    if (visibleFindings.length === 0) {
                      return (
                        <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-5 text-center space-y-2">
                          <ShieldCheck className="mx-auto h-6 w-6 text-emerald-700" />
                          <div className="text-xs font-semibold text-emerald-900">
                            未检出该级别的疑似违规条款
                          </div>
                          <p className="text-[11px] text-emerald-800">
                            当前知识库内容与已定义合规边界保持一致。
                          </p>
                        </div>
                      );
                    }
                    return (
                      <div className="space-y-3">
                        {visibleFindings.map((f) => {
                          const isHigh = f.severity === "high";
                          const isMed = f.severity === "medium";
                          return (
                            <article
                              key={f.finding_id}
                              className={`rounded-lg border p-3.5 space-y-2 ${
                                isHigh
                                  ? "border-red-200 bg-red-50/40"
                                  : isMed
                                  ? "border-amber-200 bg-amber-50/35"
                                  : "border-slate-200 bg-white"
                              }`}
                            >
                              <div className="flex flex-wrap items-baseline justify-between gap-1.5">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  {isHigh ? (
                                    <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-red-700" />
                                  ) : (
                                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-700" />
                                  )}
                                  <span className="truncate text-xs font-semibold text-slate-900">
                                    {f.clause_title}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1.5 text-[11px] font-mono shrink-0">
                                  <span
                                    className={
                                      isHigh
                                        ? "font-sans font-semibold text-red-700"
                                        : isMed
                                        ? "font-sans font-semibold text-amber-700"
                                        : "font-sans font-medium text-slate-600"
                                    }
                                  >
                                    {isHigh ? "高风险" : isMed ? "中风险" : "低风险"}
                                  </span>
                                  <span aria-hidden="true" className="text-slate-300">
                                    ·
                                  </span>
                                  <span className="text-slate-500">L{f.max_level}</span>
                                </div>
                              </div>

                              <div className="text-xs font-medium text-slate-800">
                                {f.rule_label}
                                <span className="ml-1.5 font-mono text-[11px] font-normal text-slate-400">
                                  {f.clause_id}
                                </span>
                              </div>

                              <p className="text-xs leading-relaxed text-slate-700">
                                {f.summary}
                              </p>

                              <div className="rounded border border-slate-200/80 bg-white/80 px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-600">
                                摘要：{f.safe_excerpt}
                              </div>

                              <div className="flex items-center justify-between gap-2 pt-1">
                                <span className="text-[11px] text-slate-500 leading-snug">
                                  建议：{f.remediation}
                                </span>
                              </div>

                              <div className="pt-1 border-t border-slate-200/60 flex justify-end">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setScanOpen(false);
                                    void runQuery(f.sample_probe_question);
                                  }}
                                  className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-700 hover:text-blue-900"
                                >
                                  <span>代入问答台验证边界</span>
                                  <ArrowRight className="h-3 w-3" />
                                </button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    );
                  })()}
                </>
              ) : null}
            </div>

            {/* Sidebar Footer */}
            {scanData && (
              <div className="border-t border-slate-200 bg-slate-50 px-5 py-2.5 text-[11px] text-slate-500 flex items-center justify-between font-mono tabular-nums">
                <span>本次扫描已写入审计日志</span>
                <span>{scanData.report.scanned_at}</span>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
