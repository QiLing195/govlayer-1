/**
 * 知识库访问权限策略引擎（RBAC + ABAC）：
 *   - 聚焦真实运行的知识库与飞书同步数据源，移除无真实代理的模拟数据库假表；
 *   - 支持多维权限控制：启用状态、最低角色级别（RBAC）、允许部门列表（ABAC）、密级标签、
 *     默认严格隔离（不披露存在性）、外部 LLM 出网开关、先例查阅最低级别；
 *   - 所有策略实时生效于 /api/ask、/api/v1/gateway/govern、/api/v1/chat/completions、
 *     /api/datasets/:id/clauses 与 /api/datasets/:id/precedents，并持久化至 audit/policies.json。
 */

import fs from "node:fs";
import path from "node:path";

export type DataClassification = "public" | "internal" | "confidential" | "restricted";
export type SourceType = "local" | "feishu_wiki" | "feishu_bitable" | "feishu_doc";

export interface KnowledgeBasePolicy {
  dataset_id: string;
  enabled: boolean;
  min_level: number;
  allowed_departments: string[]; // 空数组表示全公司部门均可访问
  classification: DataClassification;
  source_type: SourceType;
  default_strict_mode: boolean;
  allow_llm: boolean;
  allow_precedent_read: number;
  updated_at: string;
  updated_by: string;
}

interface PersistedPolicies {
  knowledge_bases: Record<string, KnowledgeBasePolicy>;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function defaultPolicy(
  datasetId: string,
  sourceType: SourceType = "local"
): KnowledgeBasePolicy {
  return {
    dataset_id: datasetId,
    enabled: true,
    min_level: 0,
    allowed_departments: [],
    classification: "internal",
    source_type: sourceType,
    default_strict_mode: false,
    allow_llm: true,
    allow_precedent_read: 0,
    updated_at: nowIso(),
    updated_by: "系统默认策略",
  };
}

export class PolicyStore {
  private readonly filePath: string;
  private readonly kbPolicies = new Map<string, KnowledgeBasePolicy>();

  constructor(
    initialDatasets: Array<{ id: string; sourceType?: SourceType }>,
    customPath?: string
  ) {
    this.filePath = path.resolve(
      customPath ?? path.join(process.cwd(), "audit", "policies.json")
    );
    for (const ds of initialDatasets) {
      this.kbPolicies.set(ds.id, defaultPolicy(ds.id, ds.sourceType ?? "local"));
    }
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(
        fs.readFileSync(this.filePath, "utf-8")
      ) as Partial<PersistedPolicies>;
      if (raw.knowledge_bases && typeof raw.knowledge_bases === "object") {
        for (const [id, p] of Object.entries(raw.knowledge_bases)) {
          if (this.kbPolicies.has(id) && p && typeof p === "object") {
            const base = this.kbPolicies.get(id)!;
            this.kbPolicies.set(id, {
              ...base,
              ...p,
              dataset_id: id,
              allowed_departments: Array.isArray(p.allowed_departments)
                ? p.allowed_departments.map((d) => String(d)).filter(Boolean)
                : base.allowed_departments,
            });
          }
        }
      }
    } catch {
      // Ignore malformed file
    }
  }

  private saveToDisk(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const payload: PersistedPolicies = {
        knowledge_bases: Object.fromEntries(this.kbPolicies.entries()),
      };
      fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf-8");
    } catch {
      // Best-effort persistence
    }
  }

  ensureKnowledgeBase(datasetId: string, sourceType: SourceType = "local"): KnowledgeBasePolicy {
    const existing = this.kbPolicies.get(datasetId);
    if (existing) {
      if (sourceType !== "local" && existing.source_type !== sourceType) {
        existing.source_type = sourceType;
        this.saveToDisk();
      }
      return existing;
    }
    const created = defaultPolicy(datasetId, sourceType);
    this.kbPolicies.set(datasetId, created);
    this.saveToDisk();
    return created;
  }

  getKnowledgeBasePolicy(datasetId: string): KnowledgeBasePolicy {
    return this.ensureKnowledgeBase(datasetId, "local");
  }

  listKnowledgeBasePolicies(): KnowledgeBasePolicy[] {
    return Array.from(this.kbPolicies.values());
  }

  updateKnowledgeBasePolicy(
    datasetId: string,
    patch: Partial<
      Pick<
        KnowledgeBasePolicy,
        | "enabled"
        | "min_level"
        | "allowed_departments"
        | "classification"
        | "default_strict_mode"
        | "allow_llm"
        | "allow_precedent_read"
      >
    >,
    updatedBy: string
  ): KnowledgeBasePolicy | null {
    const current = this.kbPolicies.get(datasetId);
    if (!current) return null;

    const validClass = (c: unknown): DataClassification => {
      if (c === "public" || c === "internal" || c === "confidential" || c === "restricted") {
        return c;
      }
      return current.classification;
    };

    const next: KnowledgeBasePolicy = {
      ...current,
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
      min_level:
        patch.min_level !== undefined
          ? Math.max(0, Math.min(2, Math.trunc(patch.min_level)))
          : current.min_level,
      allowed_departments:
        patch.allowed_departments !== undefined
          ? Array.from(
              new Set(
                patch.allowed_departments
                  .map((d) => String(d).trim().slice(0, 64))
                  .filter(Boolean)
              )
            ).slice(0, 30)
          : current.allowed_departments,
      classification:
        patch.classification !== undefined
          ? validClass(patch.classification)
          : current.classification,
      default_strict_mode:
        patch.default_strict_mode !== undefined
          ? Boolean(patch.default_strict_mode)
          : current.default_strict_mode,
      allow_llm: patch.allow_llm !== undefined ? Boolean(patch.allow_llm) : current.allow_llm,
      allow_precedent_read:
        patch.allow_precedent_read !== undefined
          ? Math.max(0, Math.min(2, Math.trunc(patch.allow_precedent_read)))
          : current.allow_precedent_read,
      updated_at: nowIso(),
      updated_by: updatedBy,
    };

    this.kbPolicies.set(datasetId, next);
    this.saveToDisk();
    return next;
  }
}
