import { useCallback, useEffect, useState } from "react";
import { Plus, Scale } from "lucide-react";
import type { DatasetMeta, PrecedentCase, PrecedentsResponse } from "../types.ts";

interface PrecedentLibraryProps {
  dataset: DatasetMeta;
  token: string;
  onPrecedentCreated: () => void;
}

export function PrecedentLibrary({
  dataset,
  token,
  onPrecedentCreated,
}: PrecedentLibraryProps) {
  const [data, setData] = useState<PrecedentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [topic, setTopic] = useState("");
  const [question, setQuestion] = useState("");
  const [context, setContext] = useState("");
  const [ruling, setRuling] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [approver, setApprover] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadPrecedents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/datasets/${encodeURIComponent(dataset.id)}/precedents`,
        {
          headers: token ? { "X-API-Token": token } : {},
        }
      );
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string };
        setError(`无法读取先例库（HTTP ${res.status}）：${d.detail ?? "请检查令牌"}`);
        setData(null);
        return;
      }
      const json = (await res.json()) as PrecedentsResponse;
      setData(json);
    } catch {
      setError("网络异常，无法加载先例库。");
    } finally {
      setLoading(false);
    }
  }, [dataset.id, token]);

  useEffect(() => {
    void loadPrecedents();
  }, [loadPrecedents]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch("/api/precedents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Token": token,
        },
        body: JSON.stringify({
          dataset: dataset.id,
          topic: topic.trim(),
          question: question.trim(),
          context: context.trim(),
          ruling: ruling.trim(),
          reasoning: reasoning.trim(),
          approver: approver.trim(),
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string };
        setFormError(`登记被拒绝（HTTP ${res.status}）：${d.detail ?? "权限不足"}`);
        return;
      }
      setShowForm(false);
      setTopic("");
      setQuestion("");
      setContext("");
      setRuling("");
      setReasoning("");
      setApprover("");
      onPrecedentCreated();
      await loadPrecedents();
    } catch {
      setFormError("提交失败，请检查网络连接。");
    } finally {
      setSubmitting(false);
    }
  }

  const cases: PrecedentCase[] = data?.precedents ?? [];
  const canManage = Boolean(data?.can_manage);

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            {dataset.name} · 人工裁决先例库
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            制度空白触发人工升级后，经 HR 或管理员裁决的案例会沉淀于此，后续同类提问将自动附带“仅供参考”的先例提示。
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-800 whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{showForm ? "收起表单" : "登记新先例"}</span>
          </button>
        ) : (
          <span className="text-xs text-slate-500">
            仅 L2 HR / 合规审计员可登记新先例
          </span>
        )}
      </section>

      {showForm && canManage && (
        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <h3 className="text-sm font-semibold text-slate-900">新建裁决先例</h3>
            {formError && (
              <p className="text-xs text-red-700">{formError}</p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  议题关键词 *
                </label>
                <input
                  type="text"
                  required
                  maxLength={80}
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="例如：出差超期 / 异地补打卡"
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:border-blue-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700">
                  审批人
                </label>
                <input
                  type="text"
                  maxLength={80}
                  value={approver}
                  onChange={(e) => setApprover(e.target.value)}
                  placeholder="例如：人力资源部负责人"
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:border-blue-600 focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                原始问题 *
              </label>
              <input
                type="text"
                required
                maxLength={500}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="员工或成员提出的具体场景问题"
                className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:border-blue-600 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                背景说明
              </label>
              <input
                type="text"
                maxLength={500}
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="例如：客户临时要求延长现场支持"
                className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:border-blue-600 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                裁决结论 *
              </label>
              <textarea
                required
                rows={3}
                maxLength={1000}
                value={ruling}
                onChange={(e) => setRuling(e.target.value)}
                placeholder="明确的书面处理口径"
                className="mt-1 w-full rounded-md border border-slate-300 bg-white p-3 text-sm focus:border-blue-600 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">
                裁决依据 / 理由
              </label>
              <input
                type="text"
                maxLength={1000}
                value={reasoning}
                onChange={(e) => setReasoning(e.target.value)}
                placeholder="为何这样裁决，便于后续复盘"
                className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:border-blue-600 focus:outline-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-md bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800 disabled:opacity-50"
              >
                {submitting ? "提交中..." : "保存并写入审计"}
              </button>
            </div>
          </form>
        </section>
      )}

      {error && (
        <section className="rounded-lg border border-red-200 bg-red-50/70 p-4 text-sm text-red-800">
          {error}
        </section>
      )}

      {loading ? (
        <div className="h-32 animate-pulse rounded-lg border border-slate-200 bg-white" />
      ) : cases.length === 0 ? (
        <section className="rounded-lg border border-slate-200 bg-white px-6 py-12 text-center">
          <Scale className="mx-auto h-7 w-7 text-slate-400" />
          <h3 className="mt-3 text-sm font-semibold text-slate-900">
            该知识库尚无已沉淀的先例
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            {canManage
              ? "可点击右上角“登记新先例”记录首个空白场景裁决。"
              : "切换至 L2 HR / 合规审计员身份后可登记人工裁决先例。"}
          </p>
        </section>
      ) : (
        <section className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {cases.map((c) => (
            <article key={c.case_id} className="px-5 py-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="font-mono font-semibold text-slate-900">
                    {c.case_id}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-medium text-slate-800">{c.topic}</span>
                  <span aria-hidden="true">·</span>
                  <span>{c.date}</span>
                  <span aria-hidden="true">·</span>
                  <span>审批人：{c.approver}</span>
                </div>
                <span className="text-xs text-amber-700">仅供参考，不替代正式修订</span>
              </div>
              {c.question && (
                <p className="text-xs text-slate-600">原始提问：{c.question}</p>
              )}
              <p className="text-sm leading-relaxed text-slate-900">{c.ruling}</p>
              {c.reasoning && (
                <p className="text-xs text-slate-500">依据：{c.reasoning}</p>
              )}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
