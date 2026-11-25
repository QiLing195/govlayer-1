import { useCallback, useEffect, useState } from "react";
import {
  CloudDownload,
  FileText,
  KeyRound,
  Menu,
  MessageSquareText,
  Scale,
  Shield,
  ShieldCheck,
  X,
} from "lucide-react";
import { AccessControlConsole } from "./components/AccessControlConsole.tsx";
import { AuditConsole } from "./components/AuditConsole.tsx";
import { ClauseExplorer } from "./components/ClauseExplorer.tsx";
import { FeishuGatewayConsole } from "./components/FeishuGatewayConsole.tsx";
import { PrecedentLibrary } from "./components/PrecedentLibrary.tsx";
import { QueryConsole } from "./components/QueryConsole.tsx";
import type { DatasetMeta, TokenOption, TokensResponse } from "./types.ts";

type ViewId = "query" | "clauses" | "precedents" | "permissions" | "feishu" | "audit";

const NAV_ITEMS: Array<{ id: ViewId; label: string; icon: typeof MessageSquareText }> = [
  { id: "query", label: "治理问答台", icon: MessageSquareText },
  { id: "clauses", label: "条款与权限边界", icon: FileText },
  { id: "precedents", label: "先例裁决库", icon: Scale },
  { id: "permissions", label: "访问权限管理", icon: Shield },
  { id: "feishu", label: "飞书与网关", icon: CloudDownload },
  { id: "audit", label: "审计留痕", icon: ShieldCheck },
];

export default function App() {
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [activeDatasetId, setActiveDatasetId] = useState<string>("");
  const [demoMode, setDemoMode] = useState(true);
  const [tokens, setTokens] = useState<TokenOption[]>([]);
  // Token kept strictly in React memory (never persisted to localStorage)
  const [activeToken, setActiveToken] = useState<string>("");
  const [activeView, setActiveView] = useState<ViewId>("query");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  const loadDatasets = useCallback(async (selectId?: string) => {
    const res = await fetch("/api/datasets");
    if (!res.ok) throw new Error("datasets_load_failed");
    const list = (await res.json()) as DatasetMeta[];
    setDatasets(list);
    setActiveDatasetId((prev) => {
      if (selectId && list.some((d) => d.id === selectId)) return selectId;
      return prev && list.some((d) => d.id === prev) ? prev : (list[0]?.id ?? "");
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const [, tokRes] = await Promise.all([loadDatasets(), fetch("/api/tokens")]);
        if (!tokRes.ok) throw new Error("tokens_load_failed");
        const tokData = (await tokRes.json()) as TokensResponse;
        if (!cancelled) {
          setDemoMode(tokData.demo_mode);
          setTokens(tokData.tokens);
          if (tokData.tokens.length > 0) {
            setActiveToken(tokData.tokens[0].token);
          }
        }
      } catch {
        if (!cancelled) {
          setBootError("治理服务初始化失败，请刷新页面重试。");
        }
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [loadDatasets]);

  const activeDataset = datasets.find((d) => d.id === activeDatasetId) ?? null;
  const activeTokenInfo = tokens.find((t) => t.token === activeToken) ?? null;
  const activeLevel = activeTokenInfo?.level ?? 0;
  const activeViewLabel =
    NAV_ITEMS.find((n) => n.id === activeView)?.label ?? "治理问答台";

  const sidebarContent = (
    <div className="flex h-full flex-col">
      {/* Brand Wordmark */}
      <div className="flex h-14 items-center justify-between border-b border-slate-200 px-5">
        <span className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap">
          GovLayer
        </span>
        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          aria-label="关闭侧边栏"
          className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        <nav aria-label="主导航" className="space-y-1">
          <div className="px-2.5 pb-1 text-xs font-medium text-slate-400">
            治理工作台
          </div>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveView(item.id);
                  setSidebarOpen(false);
                }}
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
                  active
                    ? "bg-blue-50 text-blue-700"
                    : "text-slate-700 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Knowledge Base Switcher */}
        <div className="space-y-1">
          <div className="px-2.5 pb-1 text-xs font-medium text-slate-400">
            知识库语料
          </div>
          {datasets.map((ds) => {
            const selected = ds.id === activeDatasetId;
            return (
              <button
                key={ds.id}
                type="button"
                onClick={() => {
                  setActiveDatasetId(ds.id);
                  setSidebarOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors ${
                  selected
                    ? "bg-slate-900 font-medium text-white"
                    : "text-slate-700 hover:bg-slate-100"
                }`}
              >
                <span className="truncate">{ds.name}</span>
                <span
                  className={`shrink-0 font-mono tabular-nums ${
                    selected ? "text-slate-300" : "text-slate-400"
                  }`}
                >
                  {ds.n_objects}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Identity Token Panel (Server-verified RBAC + ABAC) */}
      <div className="border-t border-slate-200 p-4 space-y-2.5 bg-slate-50/70">
        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
          <KeyRound className="h-3.5 w-3.5 text-slate-500" />
          <span>当前身份令牌</span>
        </div>
        {demoMode && tokens.length > 0 ? (
          <select
            aria-label="选择演示身份令牌"
            value={activeToken}
            onChange={(e) => setActiveToken(e.target.value)}
            className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
          >
            {tokens.map((t) => (
              <option key={t.token} value={t.token}>
                L{t.level} · {t.label}（{t.department}）
              </option>
            ))}
          </select>
        ) : (
          <input
            type="password"
            value={activeToken}
            onChange={(e) => setActiveToken(e.target.value)}
            placeholder="输入服务端签发的 API Token"
            className="h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
          />
        )}
        <p className="text-[11px] leading-relaxed text-slate-500">
          级别与部门属性由服务端令牌解析，支持 <span className="font-mono">X-API-Token</span>{" "}
          与 <span className="font-mono">Bearer</span> 认证。
        </p>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      {/* Desktop Sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white lg:block">
        <div className="sticky top-0 h-screen">{sidebarContent}</div>
      </aside>

      {/* Mobile Sidebar Drawer */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="relative z-50 w-64 bg-white shadow-xl">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Bar Contract: Breadcrumb on left, concise context + 1 primary action on right */}
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="打开导航菜单"
              className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="font-medium text-slate-500 whitespace-nowrap">
                {activeDataset?.name ?? "知识库"}
              </span>
              <span aria-hidden="true" className="text-slate-300">
                /
              </span>
              <h1 className="truncate font-semibold text-slate-900">
                {activeViewLabel}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <span className="hidden text-xs text-slate-500 sm:inline whitespace-nowrap">
              {activeTokenInfo
                ? `L${activeTokenInfo.level} · ${activeTokenInfo.label} · ${activeTokenInfo.department}`
                : activeToken
                ? "自定义令牌"
                : "未提供令牌"}
            </span>
            {activeView !== "audit" ? (
              <button
                type="button"
                onClick={() => setActiveView("audit")}
                className="rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-800 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                查看审计日志
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setActiveView("query")}
                className="rounded-md bg-blue-700 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-800 whitespace-nowrap shrink-0"
              >
                返回问答台
              </button>
            )}
          </div>
        </header>

        {/* Viewport Container */}
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
          {bootError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-800">
              {bootError}
            </div>
          ) : !activeDataset ? (
            <div className="h-40 animate-pulse rounded-lg border border-slate-200 bg-white" />
          ) : activeView === "query" ? (
            <QueryConsole
              key={activeDataset.id}
              dataset={activeDataset}
              token={activeToken}
              activeLevel={activeLevel}
              onPrecedentCreated={() => void loadDatasets()}
            />
          ) : activeView === "clauses" ? (
            <ClauseExplorer dataset={activeDataset} token={activeToken} />
          ) : activeView === "precedents" ? (
            <PrecedentLibrary
              dataset={activeDataset}
              token={activeToken}
              onPrecedentCreated={() => void loadDatasets()}
            />
          ) : activeView === "permissions" ? (
            <AccessControlConsole
              token={activeToken}
              onPoliciesUpdated={() => void loadDatasets()}
            />
          ) : activeView === "feishu" ? (
            <FeishuGatewayConsole
              token={activeToken}
              datasets={datasets}
              activeDatasetId={activeDataset.id}
              onDatasetSynced={(newId) => void loadDatasets(newId)}
            />
          ) : (
            <AuditConsole token={activeToken} />
          )}
        </main>
      </div>
    </div>
  );
}
