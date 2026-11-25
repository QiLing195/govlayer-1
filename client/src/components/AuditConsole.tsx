import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, Search, ShieldOff } from "lucide-react";
import type { AuditResponse } from "../types.ts";

interface AuditConsoleProps {
  token: string;
}

type EventFilter =
  | "all"
  | "ask"
  | "gateway_call"
  | "feishu_sync"
  | "policy_updated"
  | "auth_failed"
  | "audit_denied"
  | "precedent_created";

const EVENT_LABELS: Record<string, string> = {
  ask: "合规问答",
  gateway_call: "网关调用",
  feishu_sync: "飞书同步",
  risk_scan: "全库扫描",
  policy_updated: "策略变更",
  auth_failed: "鉴权失败",
  audit_denied: "越权拦截",
  ask_denied: "策略拦截",
  precedent_created: "沉淀先例",
  error: "异常",
};

const VERDICT_LABELS: Record<string, { text: string; cls: string }> = {
  covered: { text: "明文可答", cls: "text-emerald-700" },
  restricted: { text: "权限受限", cls: "text-red-700" },
  gap: { text: "制度空白", cls: "text-amber-700" },
  out_of_scope: { text: "范围外", cls: "text-slate-600" },
};

export function AuditConsole({ token }: AuditConsoleProps) {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [deniedDetail, setDeniedDetail] = useState<{ status: number; message: string } | null>(
    null
  );
  const [eventFilter, setEventFilter] = useState<EventFilter>("all");
  const [search, setSearch] = useState("");

  const loadAudit = useCallback(async () => {
    setLoading(true);
    setDeniedDetail(null);
    try {
      const qs = new URLSearchParams({ limit: "100" });
      if (eventFilter !== "all") {
        qs.set("event", eventFilter);
      }
      const res = await fetch(`/api/audit?${qs.toString()}`, {
        headers: token ? { "X-API-Token": token } : {},
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string };
        setDeniedDetail({
          status: res.status,
          message: d.detail ?? "无权访问审计日志",
        });
        setData(null);
        return;
      }
      const json = (await res.json()) as AuditResponse;
      setData(json);
    } catch {
      setDeniedDetail({ status: 0, message: "无法连接到审计服务" });
    } finally {
      setLoading(false);
    }
  }, [eventFilter, token]);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  async function handleExportCsv() {
    setExporting(true);
    try {
      const qs = new URLSearchParams({ limit: "500" });
      if (eventFilter !== "all") {
        qs.set("event", eventFilter);
      }
      // Send token strictly via request header (never in URL query string)
      const res = await fetch(`/api/audit/export?${qs.toString()}`, {
        headers: token ? { "X-API-Token": token } : {},
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `govlayer-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  if (deniedDetail) {
    return (
      <section className="rounded-lg border border-red-200 bg-white p-8 text-center">
        <ShieldOff className="mx-auto h-8 w-8 text-red-600" />
        <h2 className="mt-3 text-base font-semibold text-slate-900">
          审计日志访问被拒绝（HTTP {deniedDetail.status}）
        </h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-slate-600">
          {deniedDetail.message}
        </p>
        <p className="mx-auto mt-3 max-w-md text-xs text-slate-500">
          审计日志本身受最高级别权限门控——连“谁查过什么”也不可越权窥探，且本次越权访问尝试已被自动记入审计流水。
        </p>
      </section>
    );
  }

  const stats = data?.stats;
  const records = (data?.records ?? []).filter((r) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      (r.question ?? "").toLowerCase().includes(q) ||
      (r.dataset ?? "").toLowerCase().includes(q) ||
      (r.role ?? "").toLowerCase().includes(q) ||
      (r.department ?? "").toLowerCase().includes(q) ||
      (r.identity_label ?? "").toLowerCase().includes(q) ||
      (r.resource ?? "").toLowerCase().includes(q) ||
      (r.token_fp ?? "").toLowerCase().includes(q)
    );
  });

  const deniedTotal =
    (stats?.auth_failures ?? 0) +
    (stats?.by_event?.audit_denied ?? 0) +
    (stats?.by_event?.ask_denied ?? 0);

  return (
    <div className="space-y-5">
      {/* 4-Column KPI Strip */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-3.5">
          <div className="text-xs text-slate-500">审计总流水</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-slate-900">
            {stats?.total ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            已落盘 {stats?.written_to_disk ?? 0} · 失败 {stats?.write_errors ?? 0}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-3.5">
          <div className="text-xs text-slate-500">鉴权与策略拦截</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-red-700">
            {deniedTotal}
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            鉴权失败 {stats?.auth_failures ?? 0} · 策略/越权 {(stats?.by_event?.audit_denied ?? 0) + (stats?.by_event?.ask_denied ?? 0)}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-3.5">
          <div className="text-xs text-slate-500">独立令牌指纹</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-slate-900">
            {stats?.unique_token_fingerprints ?? 0}
          </div>
          <div className="mt-1 text-xs text-slate-500">仅存 SHA-256 摘要，不存明文</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-3.5">
          <div className="text-xs text-slate-500">判定平均耗时</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-slate-900">
            {stats?.latency_ms_avg !== null && stats?.latency_ms_avg !== undefined
              ? `${stats.latency_ms_avg} ms`
              : "-"}
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            峰值 {stats?.latency_ms_max ?? "-"} ms
          </div>
        </div>
      </section>

      {/* Filter, Search & CSV Export Bar */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
            {(
              [
                ["all", "全部事件"],
                ["ask", "合规问答"],
                ["gateway_call", "网关调用"],
                ["feishu_sync", "飞书同步"],
                ["policy_updated", "策略变更"],
                ["auth_failed", "鉴权失败"],
                ["audit_denied", "越权拦截"],
                ["precedent_created", "先例登记"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setEventFilter(key)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                  eventFilter === key
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 sm:w-52">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="筛选问题、部门或指纹..."
                className="h-9 w-full rounded-md border border-slate-300 bg-white pl-8 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() => void handleExportCsv()}
              disabled={exporting || loading}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5" />
              <span>{exporting ? "导出中..." : "导出 CSV"}</span>
            </button>
            <button
              type="button"
              onClick={() => void loadAudit()}
              disabled={loading}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              <span>刷新</span>
            </button>
          </div>
        </div>
      </section>

      {/* High-Density Tabular Audit Grid */}
      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <th className="px-4 py-2.5 font-medium whitespace-nowrap">时间 (UTC)</th>
                <th className="px-4 py-2.5 font-medium whitespace-nowrap">事件</th>
                <th className="px-4 py-2.5 font-medium whitespace-nowrap">身份 / 部门 / 指纹</th>
                <th className="px-4 py-2.5 font-medium whitespace-nowrap">判定</th>
                <th className="px-4 py-2.5 font-medium">知识库与操作明细</th>
                <th className="px-4 py-2.5 font-medium whitespace-nowrap">截断字段</th>
                <th className="px-4 py-2.5 font-medium text-right whitespace-nowrap">耗时</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    正在读取审计记录...
                  </td>
                </tr>
              ) : records.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    暂无匹配的审计记录
                  </td>
                </tr>
              ) : (
                records.map((r, idx) => {
                  const vMeta = r.verdict ? VERDICT_LABELS[r.verdict] : null;
                  const evText = EVENT_LABELS[r.event ?? ""] ?? r.event ?? "-";
                  const isDeniedEvent =
                    r.event === "auth_failed" ||
                    r.event === "audit_denied" ||
                    r.event === "ask_denied";
                  const questionDisplay = r.question
                    ? r.question
                    : r.question_sha256
                    ? `sha256:${r.question_sha256}`
                    : r.question_withheld
                    ? "（未认证请求，原文已丢弃防日志投毒）"
                    : r.resource
                    ? `${r.resource}${r.action ? ` · ${r.action}` : ""}`
                    : r.reason ?? "-";

                  return (
                    <tr key={`${r.audit_id ?? r.ts ?? ""}-${idx}`} className="hover:bg-slate-50/80">
                      <td className="px-4 py-2.5 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                        {r.ts ?? "-"}
                      </td>
                      <td
                        className={`px-4 py-2.5 font-medium whitespace-nowrap ${
                          isDeniedEvent ? "text-red-700" : "text-slate-800"
                        }`}
                      >
                        {evText}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <div className="text-slate-800">
                          {r.identity_label ?? r.role ?? "未认证"}
                          {r.department ? (
                            <span className="text-slate-500"> · {r.department}</span>
                          ) : null}
                        </div>
                        <div className="font-mono text-[11px] text-slate-400">
                          fp:{r.token_fp ?? "none"}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        {vMeta ? (
                          <span className={`font-medium ${vMeta.cls}`}>{vMeta.text}</span>
                        ) : (
                          <span className="text-slate-400">
                            {r.status ? `HTTP ${r.status}` : "-"}
                          </span>
                        )}
                      </td>
                      <td className="max-w-xs px-4 py-2.5 text-slate-700">
                        <div className="truncate" title={questionDisplay}>
                          {r.dataset ? `[${r.dataset}] ` : ""}
                          {questionDisplay}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-slate-600 whitespace-nowrap">
                        {r.denied_fields && r.denied_fields.length > 0
                          ? r.denied_fields.join(", ")
                          : "-"}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                        {typeof r.latency_ms === "number" ? `${r.latency_ms} ms` : "-"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {stats && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] text-slate-500">
            <span>
              存储文件：<span className="font-mono">{stats.log_path}</span>
              {stats.redact_questions ? " · 问题原文脱敏已启用" : ""}
            </span>
            <span className="font-mono tabular-nums">
              时间范围：{stats.first_ts ?? "-"} ~ {stats.last_ts ?? "-"}
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
