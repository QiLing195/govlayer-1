import { useEffect, useState } from "react";
import { AlertTriangle, Lock, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import type { ClausesResponse, ComplianceSummary, DatasetMeta } from "../types.ts";

interface ClauseExplorerProps {
  dataset: DatasetMeta;
  token: string;
}

type TierFilter = "all" | "high_risk" | "redacted" | "public";

const GRADE_STYLE: Record<
  ComplianceSummary["grade"],
  { text: string; stroke: string; bar: string }
> = {
  excellent: {
    text: "text-emerald-700",
    stroke: "stroke-emerald-600",
    bar: "bg-emerald-600",
  },
  good: {
    text: "text-blue-700",
    stroke: "stroke-blue-600",
    bar: "bg-blue-600",
  },
  warning: {
    text: "text-amber-700",
    stroke: "stroke-amber-500",
    bar: "bg-amber-500",
  },
  critical: {
    text: "text-red-700",
    stroke: "stroke-red-600",
    bar: "bg-red-600",
  },
};

export function ClauseExplorer({ dataset, token }: ClauseExplorerProps) {
  const [data, setData] = useState<ClausesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<TierFilter>("all");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/datasets/${encodeURIComponent(dataset.id)}/clauses`,
          {
            headers: token ? { "X-API-Token": token } : {},
          }
        );
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { detail?: string };
          if (!cancelled) {
            setError(`无法加载条款（HTTP ${res.status}）：${d.detail ?? "请检查身份令牌"}`);
            setData(null);
          }
          return;
        }
        const json = (await res.json()) as ClausesResponse;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setError("网络异常，无法读取知识库条款。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [dataset.id, token]);

  const clauses = data?.clauses ?? [];
  const compliance = data?.compliance ?? null;
  const highRiskCount = clauses.filter((c) => c.risk_level === "high").length;
  const redactedCount = clauses.filter((c) => c.redacted_levels.length > 0).length;

  const filtered = clauses.filter((c) => {
    if (filter === "high_risk" && c.risk_level !== "high") return false;
    if (filter === "redacted" && c.redacted_levels.length === 0) return false;
    if (filter === "public" && c.redacted_levels.length > 0) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      c.title.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q) ||
      c.keywords.some((k) => k.toLowerCase().includes(q)) ||
      c.visible_tiers.some((t) => t.content.toLowerCase().includes(q)) ||
      c.risk_reasons.some((r) => r.toLowerCase().includes(q))
    );
  });

  const gradeStyle = compliance ? GRADE_STYLE[compliance.grade] : GRADE_STYLE.good;
  const ringRadius = 38;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const scoreOffset = compliance
    ? ringCircumference * (1 - Math.max(0, Math.min(100, compliance.overall_score)) / 100)
    : ringCircumference;

  return (
    <div className="space-y-5">
      {/* Compliance Score Visual Dashboard */}
      {compliance && (
        <section className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
          <div className="grid gap-6 p-5 lg:grid-cols-12 lg:items-center">
            {/* Score Gauge */}
            <div className="flex items-center gap-4 lg:col-span-4">
              <div className="relative h-24 w-24 shrink-0">
                <svg viewBox="0 0 96 96" className="h-24 w-24 -rotate-90" aria-hidden="true">
                  <circle
                    cx="48"
                    cy="48"
                    r={ringRadius}
                    fill="none"
                    strokeWidth="7"
                    className="stroke-slate-100"
                  />
                  <circle
                    cx="48"
                    cy="48"
                    r={ringRadius}
                    fill="none"
                    strokeWidth="7"
                    strokeLinecap="round"
                    strokeDasharray={ringCircumference}
                    strokeDashoffset={scoreOffset}
                    className={`${gradeStyle.stroke} transition-all duration-500`}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="font-mono text-2xl font-bold tabular-nums text-slate-900">
                    {compliance.overall_score}
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">/ 100</span>
                </div>
              </div>

              <div className="min-w-0 space-y-1">
                <div className="text-xs font-medium text-slate-500">制度合规性综合得分</div>
                <div className={`text-base font-semibold ${gradeStyle.text}`}>
                  {compliance.grade_label}
                </div>
                <p className="text-xs text-slate-500 leading-relaxed">
                  {dataset.name} · 共{" "}
                  <span className="font-mono tabular-nums text-slate-700">
                    {compliance.total_clauses}
                  </span>{" "}
                  条条款
                </p>
              </div>
            </div>

            {/* 4 Dimension Bars */}
            <div className="grid gap-3 sm:grid-cols-2 lg:col-span-5">
              {compliance.dimensions.map((dim) => {
                const pct =
                  dim.max_score > 0
                    ? Math.round((dim.score / dim.max_score) * 100)
                    : 0;
                const barColor =
                  pct >= 80
                    ? "bg-emerald-600"
                    : pct >= 60
                    ? "bg-blue-600"
                    : "bg-amber-500";
                return (
                  <div key={dim.key} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="font-medium text-slate-700 truncate">
                        {dim.label}
                      </span>
                      <span className="font-mono tabular-nums text-slate-600 shrink-0">
                        {dim.score}/{dim.max_score}
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full ${barColor} transition-all duration-500`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="text-[11px] text-slate-400 truncate" title={dim.detail}>
                      {dim.detail}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Clause Risk Breakdown */}
            <div className="grid grid-cols-3 gap-2 border-t border-slate-100 pt-4 lg:col-span-3 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
              <button
                type="button"
                onClick={() =>
                  setFilter((prev) => (prev === "high_risk" ? "all" : "high_risk"))
                }
                className={`rounded-md border px-2.5 py-2 text-left transition-colors ${
                  filter === "high_risk"
                    ? "border-red-300 bg-red-50"
                    : "border-slate-200 bg-slate-50/70 hover:border-red-200 hover:bg-red-50/50"
                }`}
              >
                <div className="text-[11px] text-red-700 font-medium">高风险</div>
                <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-red-700">
                  {compliance.high_risk_count}
                </div>
              </button>
              <div className="rounded-md border border-slate-200 bg-slate-50/70 px-2.5 py-2">
                <div className="text-[11px] text-amber-700 font-medium">中风险</div>
                <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-amber-700">
                  {compliance.medium_risk_count}
                </div>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50/70 px-2.5 py-2">
                <div className="text-[11px] text-slate-500 font-medium">常规</div>
                <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-slate-800">
                  {compliance.low_risk_count}
                </div>
              </div>
              {compliance.unprotected_sensitive_count > 0 && (
                <div className="col-span-3 text-[11px] text-red-700 leading-snug">
                  含 {compliance.unprotected_sensitive_count} 条公开层敏感项待分级
                </div>
              )}
            </div>
          </div>

          {/* Governance Recommendations Strip */}
          {compliance.recommendations.length > 0 && (
            <div className="flex items-start gap-2 bg-slate-50/60 px-5 py-3 text-xs text-slate-600">
              {compliance.grade === "excellent" ? (
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
              ) : (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
              )}
              <div className="space-y-0.5">
                {compliance.recommendations.map((rec, i) => (
                  <p key={i}>{rec}</p>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Toolbar */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative flex-1 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="检索条款标题、编号、风险原因或关键词..."
              className="h-9 w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
              {(
                [
                  ["all", `全部条款 (${clauses.length})`],
                  ["high_risk", `高风险条款 (${highRiskCount})`],
                  ["redacted", `含隐藏高密级 (${redactedCount})`],
                  ["public", `完全可见 (${clauses.length - redactedCount})`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                    filter === key
                      ? "bg-white text-slate-900 shadow-xs"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {data && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
            <span>当前视图权限：{data.identity}</span>
            <span aria-hidden="true">·</span>
            <span>高于 L{data.level} 的条款正文在服务端直接裁剪，不会下发至浏览器</span>
          </div>
        )}
      </section>

      {error && (
        <section className="rounded-lg border border-red-200 bg-red-50/70 p-4 text-sm text-red-800">
          {error}
        </section>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-lg border border-slate-200 bg-white"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <section className="rounded-lg border border-slate-200 bg-white px-6 py-10 text-center text-sm text-slate-500">
          没有符合筛选条件的条款。
        </section>
      ) : (
        <section className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {filtered.map((clause) => {
            const isHighRisk = clause.risk_level === "high";
            const isMediumRisk = clause.risk_level === "medium";
            return (
              <article
                key={clause.id}
                className={`px-5 py-4 space-y-2.5 transition-colors ${
                  isHighRisk ? "bg-red-50/45 ring-1 ring-inset ring-red-200/70" : ""
                }`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {isHighRisk && (
                      <ShieldAlert className="h-4 w-4 shrink-0 text-red-700" />
                    )}
                    <h3
                      className={`text-sm font-semibold ${
                        isHighRisk ? "text-red-950" : "text-slate-900"
                      }`}
                    >
                      {clause.title}
                    </h3>
                    <span className="font-mono text-xs text-slate-400">
                      {clause.id}
                    </span>
                    {isHighRisk && (
                      <>
                        <span aria-hidden="true" className="text-red-300">
                          ·
                        </span>
                        <span className="text-xs font-semibold text-red-700">
                          高风险条款
                        </span>
                      </>
                    )}
                    {isMediumRisk && (
                      <>
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        <span className="text-xs font-medium text-amber-700">
                          中风险受控
                        </span>
                      </>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 font-mono tabular-nums">
                    最高密级 L{clause.max_level}
                    {clause.redacted_levels.length > 0 && (
                      <span className="ml-2 text-red-700 font-sans font-medium">
                        已隐藏 L{clause.redacted_levels.join("/L")}
                      </span>
                    )}
                  </div>
                </div>

                {/* High-Risk / Medium-Risk Highlight Reason Bar */}
                {isHighRisk && clause.risk_reasons.length > 0 && (
                  <div className="rounded-md border border-red-200/90 bg-white/80 px-3 py-2 text-xs text-red-800">
                    <span className="font-semibold text-red-700">风险提示：</span>
                    {clause.risk_reasons.join("；")}
                  </div>
                )}

                {clause.visible_tiers.length > 0 ? (
                  <div className="space-y-2">
                    {clause.visible_tiers.map((t) => (
                      <div key={t.level} className="text-sm leading-relaxed text-slate-700">
                        <span className="mr-2 font-mono text-xs font-medium text-slate-500">
                          [L{t.level}]
                        </span>
                        <span className="whitespace-pre-wrap">{t.content}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-red-700">
                    <Lock className="h-3.5 w-3.5 shrink-0" />
                    <span>该条款全部内容均超出当前身份权限，服务端未返回正文。</span>
                  </div>
                )}

                {clause.redacted_levels.length > 0 && clause.visible_tiers.length > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-amber-800">
                    <Lock className="h-3.5 w-3.5 shrink-0" />
                    <span>
                      另有 L{clause.redacted_levels.join("、L")} 级别内部细则已按权限截断
                    </span>
                  </div>
                )}

                {clause.keywords.length > 0 && (
                  <div className="text-xs text-slate-400">
                    关键词：{clause.keywords.join(" · ")}
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
