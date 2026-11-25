import { useCallback, useEffect, useState } from "react";
import { BookLock, RefreshCw, ShieldAlert } from "lucide-react";
import type {
  DataClassification,
  KnowledgeBasePolicyItem,
  PoliciesResponse,
  SourceType,
} from "../types.ts";

interface AccessControlConsoleProps {
  token: string;
  onPoliciesUpdated: () => void;
}

const LEVEL_OPTIONS = [
  { value: 0, label: "L0 全员可访" },
  { value: 1, label: "L1 主管及以上" },
  { value: 2, label: "L2 HR / 审计专属" },
];

const CLASS_OPTIONS: Array<{ value: DataClassification; label: string }> = [
  { value: "public", label: "公开 (Public)" },
  { value: "internal", label: "内部 (Internal)" },
  { value: "confidential", label: "机密 (Confidential)" },
  { value: "restricted", label: "绝密受控 (Restricted)" },
];

const SOURCE_LABELS: Record<SourceType, string> = {
  local: "内置语料",
  feishu_wiki: "飞书知识空间",
  feishu_bitable: "飞书多维表格",
  feishu_doc: "飞书分层文档",
};

export function AccessControlConsole({
  token,
  onPoliciesUpdated,
}: AccessControlConsoleProps) {
  const [data, setData] = useState<PoliciesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const loadPolicies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/policies", {
        headers: token ? { "X-API-Token": token } : {},
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string };
        setError(`权限策略加载失败（HTTP ${res.status}）：${d.detail ?? "请检查身份令牌"}`);
        setData(null);
        return;
      }
      const json = (await res.json()) as PoliciesResponse;
      setData(json);
    } catch {
      setError("无法连接到策略服务，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadPolicies();
  }, [loadPolicies]);

  async function patchKbPolicy(
    kb: KnowledgeBasePolicyItem,
    patch: Partial<{
      enabled: boolean;
      min_level: number;
      allowed_departments: string[];
      classification: DataClassification;
      default_strict_mode: boolean;
      allow_llm: boolean;
      allow_precedent_read: number;
    }>
  ) {
    setSavingId(kb.dataset_id);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch(`/api/policies/kb/${encodeURIComponent(kb.dataset_id)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-API-Token": token,
        },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string };
        setError(`策略保存失败（HTTP ${res.status}）：${d.detail ?? "权限不足"}`);
        return;
      }
      setNotice(`已更新知识库「${kb.name}」的 RBAC + ABAC 访问策略，实时生效并已记入审计流水。`);
      await loadPolicies();
      onPoliciesUpdated();
    } finally {
      setSavingId(null);
    }
  }

  function toggleDepartment(kb: KnowledgeBasePolicyItem, dept: string) {
    const current = kb.allowed_departments;
    const next = current.includes(dept)
      ? current.filter((d) => d !== dept)
      : [...current, dept];
    void patchKbPolicy(kb, { allowed_departments: next });
  }

  const canManage = Boolean(data?.can_manage);
  const departments = data?.departments ?? [];

  return (
    <div className="space-y-5">
      {/* Header Summary */}
      <section className="rounded-lg border border-slate-200 bg-white px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              知识库访问权限策略（RBAC + ABAC）
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              统一管控内置与飞书同步知识库的准入级别、部门访问边界、数据密级、严格隔离与外部模型出网策略。
              所有修改实时拦截 <span className="font-mono">/api/ask</span>、
              <span className="font-mono">/api/v1/gateway/govern</span> 与{" "}
              <span className="font-mono">/api/v1/chat/completions</span> 请求。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadPolicies()}
            disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>刷新策略</span>
          </button>
        </div>

        {data && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 pt-3 text-xs text-slate-600">
            <span>
              当前身份：<span className="font-medium text-slate-900">{data.caller_identity}</span>
            </span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span>
              所属部门：<span className="font-medium text-slate-900">{data.caller_department}</span>
            </span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span className="font-mono">级别 L{data.caller_level}</span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            {canManage ? (
              <span className="font-medium text-emerald-700">可编辑策略（L2 合规管理员）</span>
            ) : (
              <span className="text-amber-700">
                只读视图（切换至 L{data.auditor_level} HR / 合规审计员令牌后可修改策略）
              </span>
            )}
          </div>
        )}
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

      {/* Policy Cards */}
      {loading && !data ? (
        <div className="space-y-3">
          <div className="h-32 animate-pulse rounded-lg border border-slate-200 bg-white" />
          <div className="h-32 animate-pulse rounded-lg border border-slate-200 bg-white" />
        </div>
      ) : (
        <div className="space-y-4">
          {(data?.knowledge_bases ?? []).map((kb) => {
            const busy = savingId === kb.dataset_id;
            const allDeptsAllowed = kb.allowed_departments.length === 0;
            return (
              <section
                key={kb.dataset_id}
                className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100"
              >
                {/* Row 1: Identity & Source */}
                <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <BookLock className="h-4 w-4 shrink-0 text-slate-400" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <h3 className="text-sm font-semibold text-slate-900">{kb.name}</h3>
                        <span className="font-mono text-xs text-slate-400">{kb.dataset_id}</span>
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        <span className="text-xs text-slate-500">
                          {SOURCE_LABELS[kb.source_type] ?? kb.source_type}
                        </span>
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        <span className="font-mono text-xs tabular-nums text-slate-500">
                          {kb.n_objects} 条条款
                        </span>
                      </div>
                    </div>
                  </div>

                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      disabled={!canManage || busy}
                      checked={kb.enabled}
                      onChange={(e) => void patchKbPolicy(kb, { enabled: e.target.checked })}
                      className="h-4 w-4 rounded border-slate-300 text-blue-700 disabled:opacity-50"
                    />
                    <span className={kb.enabled ? "font-medium text-emerald-700" : "font-medium text-red-700"}>
                      {kb.enabled ? "策略启用中" : "已停用（拒绝全员查询）"}
                    </span>
                  </label>
                </div>

                {/* Row 2: RBAC Controls */}
                <div className="grid gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500">
                      最低准入角色（RBAC）
                    </label>
                    <select
                      aria-label={`${kb.name} 最低准入级别`}
                      disabled={!canManage || busy}
                      value={kb.min_level}
                      onChange={(e) =>
                        void patchKbPolicy(kb, { min_level: Number(e.target.value) })
                      }
                      className="mt-1.5 h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900 disabled:bg-slate-50 disabled:text-slate-500"
                    >
                      {LEVEL_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-500">
                      数据密级分类
                    </label>
                    <select
                      aria-label={`${kb.name} 数据密级分类`}
                      disabled={!canManage || busy}
                      value={kb.classification}
                      onChange={(e) =>
                        void patchKbPolicy(kb, {
                          classification: e.target.value as DataClassification,
                        })
                      }
                      className="mt-1.5 h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900 disabled:bg-slate-50 disabled:text-slate-500"
                    >
                      {CLASS_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-500">
                      历史先例查阅级别
                    </label>
                    <select
                      aria-label={`${kb.name} 先例查阅级别`}
                      disabled={!canManage || busy}
                      value={kb.allow_precedent_read}
                      onChange={(e) =>
                        void patchKbPolicy(kb, {
                          allow_precedent_read: Number(e.target.value),
                        })
                      }
                      className="mt-1.5 h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900 disabled:bg-slate-50 disabled:text-slate-500"
                    >
                      {LEVEL_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col justify-center gap-2 pt-1">
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-700">
                      <input
                        type="checkbox"
                        disabled={!canManage || busy}
                        checked={kb.default_strict_mode}
                        onChange={(e) =>
                          void patchKbPolicy(kb, { default_strict_mode: e.target.checked })
                        }
                        className="h-4 w-4 rounded border-slate-300 text-blue-700 disabled:opacity-50"
                      />
                      <span>强制严格隔离（不披露存在性）</span>
                    </label>
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-700">
                      <input
                        type="checkbox"
                        disabled={!canManage || busy}
                        checked={kb.allow_llm}
                        onChange={(e) =>
                          void patchKbPolicy(kb, { allow_llm: e.target.checked })
                        }
                        className="h-4 w-4 rounded border-slate-300 text-blue-700 disabled:opacity-50"
                      />
                      <span>允许裁剪后上下文发往外部 LLM</span>
                    </label>
                  </div>
                </div>

                {/* Row 3: ABAC Department Boundary */}
                <div className="px-5 py-3.5 bg-slate-50/50">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-slate-600">
                      允许访问部门（ABAC 属性边界 · 未勾选任何部门时默认全公司开放，L2 合规审计员保留审计视图）
                    </span>
                    {!allDeptsAllowed && canManage && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void patchKbPolicy(kb, { allowed_departments: [] })}
                        className="text-[11px] font-medium text-blue-700 hover:underline disabled:opacity-50"
                      >
                        重置为全公司开放
                      </button>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span
                      className={`text-xs font-medium ${
                        allDeptsAllowed ? "text-emerald-700" : "text-slate-500"
                      }`}
                    >
                      {allDeptsAllowed ? "当前：全部门开放" : "当前仅限："}
                    </span>
                    {departments.map((dept) => {
                      const active = kb.allowed_departments.includes(dept);
                      return (
                        <button
                          key={dept}
                          type="button"
                          disabled={!canManage || busy}
                          onClick={() => toggleDepartment(kb, dept)}
                          className={`rounded-md border px-2.5 py-1 text-xs transition-colors whitespace-nowrap disabled:cursor-not-allowed ${
                            active
                              ? "border-blue-600 bg-blue-50 font-medium text-blue-800"
                              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900"
                          }`}
                        >
                          {dept}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
                    <span>最近变更人：{kb.updated_by}</span>
                    <span className="font-mono tabular-nums">更新时间：{kb.updated_at}</span>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
