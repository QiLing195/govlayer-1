/**
 * 通用知识治理层（GovLayer）：域无关的确定性治理框架。
 *
 * 核心能力：
 *   1. 错别字容错（透明记录，可审计）
 *   2. 确定性检索（关键词精准加权 + 标题/正文二元词组辅助召回，严格模式按权限分区隔离）
 *   3. 字段级权限隔离（levels: {0:公开, 1:主管, 2:HR}，输出前硬裁剪）
 *   4. 四态诚实判定（covered | restricted | gap | out_of_scope）+ 诚实性守卫
 *   5. 过往先例检索与闭环沉淀
 */

import fs from "node:fs";
import type { LLMSemanticBackend, SemanticCandidate, SemanticResult } from "./semantic.ts";

export const DEFAULT_TYPO_MAP: Record<string, string> = {
  矿工: "旷工",
  旷功: "旷工",
  请加: "请假",
  清假: "请假",
  打刻: "打卡",
  打咖: "打卡",
  迟道: "迟到",
  销加: "销假",
  出拆: "出差",
  绿通: "绿色通道",
  助学: "绿色通道",
};

export interface KnowledgeObject {
  id: string;
  title?: string;
  keywords?: string[];
  levels?: Record<string, string>;
}

export type ProbeRule = [string[], string[]];

export interface PrecedentCase {
  case_id?: string;
  topic?: string;
  question?: string;
  context?: string;
  ruling?: string;
  reasoning?: string;
  approver?: string;
  department?: string;
  date?: string;
  status?: string;
  reference_only?: boolean;
}

export interface PermissionModel {
  authority: string;
  source: string;
  principle?: string;
  warning: string;
  may_claim_verified: boolean;
  [key: string]: unknown;
}

export interface FeishuMeta {
  source_type?: "feishu_wiki" | "feishu_bitable" | "feishu_doc";
  space_id?: string;
  app_token?: string;
  table_id?: string;
  synced_at?: string;
  node_count?: number;
}

export interface DatasetSpec {
  dataset: string;
  name?: string;
  description: string;
  objects: KnowledgeObject[];
  roles: Record<string, number>;
  probe_rules: ProbeRule[];
  cases: PrecedentCase[];
  permission_model: PermissionModel;
  feishu_meta?: FeishuMeta;
}

export type ClauseRiskLevel = "high" | "medium" | "low";

export interface VisibleClause {
  id: string;
  title: string;
  keywords: string[];
  visible_tiers: Array<{ level: number; content: string }>;
  redacted_levels: number[];
  max_level: number;
  risk_level: ClauseRiskLevel;
  risk_reasons: string[];
}

export interface ComplianceDimension {
  key: string;
  label: string;
  score: number;
  max_score: number;
  detail: string;
}

export interface ComplianceSummary {
  overall_score: number;
  grade: "excellent" | "good" | "warning" | "critical";
  grade_label: string;
  total_clauses: number;
  high_risk_count: number;
  medium_risk_count: number;
  low_risk_count: number;
  unprotected_sensitive_count: number;
  dimensions: ComplianceDimension[];
  recommendations: string[];
}

export type RiskFindingSeverity = "high" | "medium" | "low";

export interface RiskScanFinding {
  finding_id: string;
  clause_id: string;
  clause_title: string;
  max_level: number;
  severity: RiskFindingSeverity;
  rule_code:
    | "public_sensitive_exposure"
    | "unverified_restricted_boundary"
    | "keyword_tier_leak_risk"
    | "high_tier_llm_egress"
    | "missing_retrieval_anchor";
  rule_label: string;
  summary: string;
  remediation: string;
  safe_excerpt: string;
  sample_probe_question: string;
}

export interface RiskScanReport {
  scanned_at: string;
  total_clauses: number;
  flagged_clauses: number;
  total_findings: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  compliance_score: number;
  grade_label: string;
  policy_snapshot: {
    min_level: number;
    classification: string;
    default_strict_mode: boolean;
    allow_llm: boolean;
    allowed_departments: string[];
  };
  findings: RiskScanFinding[];
}

export type Verdict = "covered" | "gap" | "out_of_scope" | "restricted";
export type RetrievalMode = "keyword" | "hybrid" | "llm";
export type RetrievalPreference = "auto" | "local" | "llm";

export interface GovAnswer {
  question: string;
  role: string;
  hit_ids: string[];
  visible_texts: Record<string, string>;
  denied_fields: string[];
  verdict: Verdict;
  precedents: PrecedentCase[];
  boundary_note: string;
  typo_corrections: string[];
  semantic_used: boolean;
  retrieval_mode: RetrievalMode;
  strict_mode: boolean;
  gap_reason: string;
}

export interface PreflightResult {
  status: "clear" | "partial_restricted" | "restricted";
  caller_level: number;
  required_level: number;
  affected_count: number;
  typo_corrections: string[];
}

export interface GovLayerOptions {
  objects: KnowledgeObject[];
  roles: Record<string, number>;
  probePairs?: ProbeRule[];
  cases?: PrecedentCase[];
  typoMap?: Record<string, string>;
  semanticBackend?: LLMSemanticBackend | null;
  strictNonexistenceDisclosure?: boolean;
  retrievalPreference?: RetrievalPreference;
}

const PRECEDENT_STOP_BIGRAMS = new Set([
  "什么", "怎么", "如何", "多少", "可以", "需要", "是否", "哪些", "这个", "那个",
  "规定", "制度", "处理", "应该", "请问", "公司", "员工", "单位", "人员", "工作",
  "一下", "有没有", "会不会", "怎么办", "怎么处",
]);

const SENSITIVE_TRIGGER_TERMS = [
  "劝退", "开除", "解聘", "辞退", "解除合同", "解除劳动合同",
  "处分", "追责", "法律责任", "处罚", "罚款", "扣工资", "扣日工资",
  "薪酬", "薪资", "成本中心", "涉密", "机密", "纪律", "警告", "记过", "撤职",
];

function extractTerms(text: string): Set<string> {
  const cleaned = text.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, " ");
  const terms = new Set<string>();
  for (const seg of cleaned.split(" ")) {
    if (!seg) continue;
    if (/^[a-z0-9]+$/.test(seg)) {
      if (seg.length >= 2) terms.add(seg);
      continue;
    }
    // Extract CJK 2-grams
    for (let i = 0; i < seg.length - 1; i += 1) {
      const bg = seg.slice(i, i + 2);
      if (!PRECEDENT_STOP_BIGRAMS.has(bg)) {
        terms.add(bg);
      }
    }
  }
  return terms;
}

export class GovLayer {
  readonly objects: KnowledgeObject[];
  readonly roles: Record<string, number>;
  private readonly probeRules: ProbeRule[];
  readonly cases: PrecedentCase[];
  readonly typoMap: Record<string, string>;
  readonly semanticBackend: LLMSemanticBackend | null;
  readonly strictNonexistenceDisclosure: boolean;
  readonly retrievalPreference: RetrievalPreference;
  private readonly keywordIndex = new Map<string, string[]>();
  private readonly termIndex = new Map<string, { titleTerms: Set<string>; tierTerms: Map<number, Set<string>> }>();

  constructor(opts: GovLayerOptions) {
    this.objects = opts.objects;
    this.roles = opts.roles;
    this.probeRules = opts.probePairs ?? [];
    this.cases = opts.cases ? [...opts.cases] : [];
    this.typoMap = opts.typoMap !== undefined ? opts.typoMap : DEFAULT_TYPO_MAP;
    this.semanticBackend = opts.semanticBackend ?? null;
    this.strictNonexistenceDisclosure = Boolean(opts.strictNonexistenceDisclosure);
    const pref = opts.retrievalPreference ?? "auto";
    if (pref !== "auto" && pref !== "local" && pref !== "llm") {
      throw new Error(`retrievalPreference 只能是 auto/local/llm，收到 ${pref}`);
    }
    this.retrievalPreference = pref;

    for (const obj of this.objects) {
      for (const kw of obj.keywords ?? []) {
        const list = this.keywordIndex.get(kw);
        if (list) {
          list.push(obj.id);
        } else {
          this.keywordIndex.set(kw, [obj.id]);
        }
      }
      const tierTerms = new Map<number, Set<string>>();
      for (const [lvlStr, content] of Object.entries(obj.levels ?? {})) {
        tierTerms.set(Number(lvlStr), extractTerms(content));
      }
      this.termIndex.set(obj.id, {
        titleTerms: extractTerms(obj.title ?? ""),
        tierTerms,
      });
    }
  }

  correctTypos(text: string): [string, string[]] {
    const corrections: string[] = [];
    let corrected = text;
    for (const [wrong, right] of Object.entries(this.typoMap)) {
      if (corrected.includes(wrong) && wrong !== right) {
        corrected = corrected.split(wrong).join(right);
        corrections.push(`${wrong}→${right}`);
      }
    }
    return [corrected, corrections];
  }

  private minFieldLevel(obj: KnowledgeObject): number {
    const keys = Object.keys(obj.levels ?? {});
    if (keys.length === 0) return 0;
    return Math.min(...keys.map((k) => Number(k)));
  }

  /**
   * 确定性检索：
   *   1) 精确关键词命中（权重 3.0，高置信）
   *   2) 标题/正文二元词组辅助召回（解决"半小时/开除/材料"等口语问法，仅当重叠 ≥ 2 项才触发，防止误捞跑题问题）
   *   当 level !== null（严格模式）时，结构性只检索该权限级别及以下字段，绝不触碰高密级正文。
   */
  retrieve(text: string, topN = 3, level: number | null = null): { ids: string[]; usedBigram: boolean } {
    const byId = new Map(this.objects.map((o) => [o.id, o]));
    const kwScored = new Map<string, number>();

    for (const [kw, ids] of this.keywordIndex.entries()) {
      if (text.includes(kw)) {
        for (const objId of ids) {
          const obj = byId.get(objId);
          if (!obj) continue;
          if (level !== null) {
            const vis = Object.entries(obj.levels ?? {})
              .filter(([lvl]) => Number(lvl) <= level)
              .map(([, content]) => content)
              .join(" ");
            if (!vis || !`${obj.title ?? ""} ${vis}`.includes(kw)) {
              continue;
            }
          }
          kwScored.set(objId, (kwScored.get(objId) ?? 0) + 3);
        }
      }
    }

    if (kwScored.size > 0) {
      const ranked = Array.from(kwScored.entries()).sort((a, b) => b[1] - a[1]);
      return { ids: ranked.slice(0, topN).map(([oid]) => oid), usedBigram: false };
    }

    // Fallback: deterministic CJK bigram / token overlap on title + accessible content
    const qTerms = extractTerms(text);
    if (qTerms.size === 0) {
      return { ids: [], usedBigram: false };
    }

    const bigramScored = new Map<string, number>();
    for (const obj of this.objects) {
      if (level !== null && this.minFieldLevel(obj) > level) {
        continue;
      }
      const entry = this.termIndex.get(obj.id);
      if (!entry) continue;

      let titleHits = 0;
      for (const t of qTerms) {
        if (entry.titleTerms.has(t)) titleHits += 1;
      }
      let contentHits = 0;
      const seenContent = new Set<string>();
      for (const [tierLvl, terms] of entry.tierTerms.entries()) {
        if (level !== null && tierLvl > level) continue;
        for (const t of qTerms) {
          if (terms.has(t) && !seenContent.has(t)) {
            seenContent.add(t);
            contentHits += 1;
          }
        }
      }
      const score = titleHits * 1.5 + contentHits;
      // Strict floor: at least 2 meaningful bigram overlaps to prevent off-topic false hits
      if (score >= 2.0) {
        bigramScored.set(obj.id, score);
      }
    }

    const ranked = Array.from(bigramScored.entries()).sort((a, b) => b[1] - a[1]);
    return { ids: ranked.slice(0, topN).map(([oid]) => oid), usedBigram: ranked.length > 0 };
  }

  roleLevel(role: string): number {
    return this.roles[role] ?? 0;
  }

  visibleContent(obj: KnowledgeObject, role: string): string {
    const level = this.roleLevel(role);
    const levels = obj.levels ?? {};
    const entries = Object.entries(levels).sort((a, b) => Number(a[0]) - Number(b[0]));
    const parts: string[] = [];
    for (const [fieldLevel, content] of entries) {
      if (Number(fieldLevel) <= level) {
        parts.push(content);
      }
    }
    return parts.join(" ");
  }

  maxFieldLevel(obj: KnowledgeObject): number {
    const keys = Object.keys(obj.levels ?? {});
    if (keys.length === 0) return 0;
    return Math.max(...keys.map((k) => Number(k)));
  }

  private assessClauseRisk(
    obj: KnowledgeObject,
    callerLevel: number,
    mayClaimVerified = false
  ): { risk_level: ClauseRiskLevel; risk_reasons: string[]; unprotectedSensitive: boolean } {
    const maxLevel = this.maxFieldLevel(obj);
    const l0Text = String(obj.levels?.["0"] ?? "");
    const hasPublicSensitiveTrigger = SENSITIVE_TRIGGER_TERMS.some((term) =>
      l0Text.includes(term)
    );
    const reasons: string[] = [];

    // High-risk case 1: Contains L2 restricted/redline tier
    if (maxLevel >= 2) {
      if (callerLevel < 2) {
        // Zero-leakage reason: never quote hidden L2 terms
        reasons.push("含 L2 级受控红线细则（已在服务端按权限截断）");
      } else {
        reasons.push("含 L2 级高敏感管理与处置细则");
      }
      if (!mayClaimVerified) {
        reasons.push("分层权限边界尚未经业务方正式确认");
      }
      return { risk_level: "high", risk_reasons: reasons, unprotectedSensitive: false };
    }

    // High-risk case 2: Public-only clause contains disciplinary/liability/compensation terms without tiering
    if (maxLevel === 0 && hasPublicSensitiveTrigger) {
      reasons.push("公开层包含处罚、追责或薪酬等敏感表述，未设置 L1/L2 分级隔离");
      return { risk_level: "high", risk_reasons: reasons, unprotectedSensitive: true };
    }

    // Medium-risk: L1 internal management rules or missing deterministic keywords
    if (maxLevel === 1) {
      reasons.push(
        callerLevel < 1
          ? "含 L1 级主管审批口径（已按权限截断）"
          : "含 L1 级内部审批与复核口径"
      );
      return { risk_level: "medium", risk_reasons: reasons, unprotectedSensitive: false };
    }

    if ((obj.keywords ?? []).length === 0) {
      reasons.push("缺少检索关键词锚点，可能影响确定性命中率");
      return { risk_level: "medium", risk_reasons: reasons, unprotectedSensitive: false };
    }

    return { risk_level: "low", risk_reasons: [], unprotectedSensitive: false };
  }

  getVisibleClauses(role: string, mayClaimVerified = false): VisibleClause[] {
    const level = this.roleLevel(role);
    return this.objects.map((obj) => {
      const entries = Object.entries(obj.levels ?? {}).sort(
        (a, b) => Number(a[0]) - Number(b[0])
      );
      const visibleTiers: Array<{ level: number; content: string }> = [];
      const redactedLevels: number[] = [];
      for (const [lvlStr, content] of entries) {
        const lvl = Number(lvlStr);
        if (lvl <= level) {
          visibleTiers.push({ level: lvl, content });
        } else {
          redactedLevels.push(lvl);
        }
      }
      const visibleCorpus = `${obj.title ?? ""} ${visibleTiers.map((t) => t.content).join(" ")}`;
      const safeKeywords =
        visibleTiers.length > 0
          ? (obj.keywords ?? []).filter((kw) => visibleCorpus.includes(kw))
          : [];
      const risk = this.assessClauseRisk(obj, level, mayClaimVerified);
      return {
        id: obj.id,
        title: obj.title ?? obj.id,
        keywords: safeKeywords,
        visible_tiers: visibleTiers,
        redacted_levels: redactedLevels,
        max_level: this.maxFieldLevel(obj),
        risk_level: risk.risk_level,
        risk_reasons: risk.risk_reasons,
      };
    });
  }

  evaluateCompliance(params: {
    role: string;
    permissionModel: PermissionModel;
    policy: {
      enabled: boolean;
      min_level: number;
      allowed_departments: string[];
      default_strict_mode: boolean;
      allow_llm: boolean;
    };
  }): ComplianceSummary {
    const total = this.objects.length;
    const callerLevel = this.roleLevel(params.role);
    const verified = Boolean(params.permissionModel.may_claim_verified);
    const authority = params.permissionModel.authority;

    let highRiskCount = 0;
    let mediumRiskCount = 0;
    let lowRiskCount = 0;
    let unprotectedSensitiveCount = 0;
    let tieredClauseCount = 0;
    let keywordCoveredCount = 0;

    for (const obj of this.objects) {
      if (this.maxFieldLevel(obj) > 0) tieredClauseCount += 1;
      if ((obj.keywords ?? []).length > 0) keywordCoveredCount += 1;
      const r = this.assessClauseRisk(obj, callerLevel, verified);
      if (r.risk_level === "high") highRiskCount += 1;
      else if (r.risk_level === "medium") mediumRiskCount += 1;
      else lowRiskCount += 1;
      if (r.unprotectedSensitive) unprotectedSensitiveCount += 1;
    }

    // 1) 权限分级与来源确认度 (0 - 30)
    const tieredRatio = total > 0 ? tieredClauseCount / total : 0;
    const tierStructurePts =
      tieredClauseCount > 0
        ? Math.round(Math.min(1, tieredRatio / 0.25) * 22)
        : authority === "standard"
        ? 15
        : 6;
    const authorityPts = verified
      ? 8
      : authority === "standard"
      ? 6
      : authority === "proposed"
      ? 3
      : 0;
    const tierScore = Math.min(30, tierStructurePts + authorityPts);

    // 2) 准入与隔离策略配置 (0 - 30)
    let policyScore = 0;
    if (params.policy.enabled) policyScore += 8;
    policyScore += params.policy.default_strict_mode ? 8 : 4;
    policyScore +=
      params.policy.allowed_departments.length > 0 || params.policy.min_level > 0 ? 7 : 3;
    policyScore += params.policy.allow_llm ? 4 : 7;
    policyScore = Math.min(30, policyScore);

    // 3) 规则与检索完整度 (0 - 25)
    const kwRatio = total > 0 ? keywordCoveredCount / total : 0;
    const kwPts = Math.round(kwRatio * 13);
    const guardPts = Math.min(
      12,
      (this.probeRules.length > 0 ? 8 : total >= 20 ? 6 : 2) +
        (this.cases.length > 0 ? 4 : 1)
    );
    const coverageScore = Math.min(25, kwPts + guardPts);

    // 4) 高风险条款受控度 (0 - 15)
    let riskControlScore = 15;
    if (unprotectedSensitiveCount > 0) {
      riskControlScore -= Math.min(9, unprotectedSensitiveCount * 3);
    }
    if (!verified && highRiskCount > 0 && authority !== "standard") {
      riskControlScore -= 3;
    }
    riskControlScore = Math.max(0, riskControlScore);

    const overall = Math.max(
      0,
      Math.min(100, tierScore + policyScore + coverageScore + riskControlScore)
    );

    let grade: ComplianceSummary["grade"];
    let gradeLabel: string;
    if (overall >= 85) {
      grade = "excellent";
      gradeLabel = "合规优良";
    } else if (overall >= 70) {
      grade = "good";
      gradeLabel = "基本合规";
    } else if (overall >= 55) {
      grade = "warning";
      gradeLabel = "存在风险";
    } else {
      grade = "critical";
      gradeLabel = "高危待整改";
    }

    const recommendations: string[] = [];
    if (unprotectedSensitiveCount > 0) {
      recommendations.push(
        `有 ${unprotectedSensitiveCount} 条公开条款包含处罚/追责/薪酬等敏感表述，建议拆分 [L1]/[L2] 密级字段。`
      );
    }
    if (!verified && authority !== "standard") {
      recommendations.push(
        "当前权限分层仍为“提议值”，建议由业务与法务确认边界后再对外宣称已验证。"
      );
    }
    if (!params.policy.default_strict_mode) {
      recommendations.push(
        "可在「访问权限管理」开启强制严格隔离（不披露高密条款存在性）或限制部门边界以进一步提升得分。"
      );
    }
    if (recommendations.length === 0) {
      recommendations.push("当前知识库权限分层、准入策略与高风险条款管控均处于良好状态。");
    }

    return {
      overall_score: overall,
      grade,
      grade_label: gradeLabel,
      total_clauses: total,
      high_risk_count: highRiskCount,
      medium_risk_count: mediumRiskCount,
      low_risk_count: lowRiskCount,
      unprotected_sensitive_count: unprotectedSensitiveCount,
      dimensions: [
        {
          key: "tier_isolation",
          label: "权限分级与确认度",
          score: tierScore,
          max_score: 30,
          detail: `${tieredClauseCount}/${total} 条配置多级隔离`,
        },
        {
          key: "policy_guard",
          label: "准入与隔离策略",
          score: policyScore,
          max_score: 30,
          detail: params.policy.default_strict_mode ? "严格隔离已启用" : "标准隔离模式",
        },
        {
          key: "coverage_integrity",
          label: "规则与检索完整度",
          score: coverageScore,
          max_score: 25,
          detail: `${keywordCoveredCount}/${total} 条含关键词 · ${this.probeRules.length} 条探针`,
        },
        {
          key: "risk_control",
          label: "高风险条款受控度",
          score: riskControlScore,
          max_score: 15,
          detail:
            unprotectedSensitiveCount > 0
              ? `${unprotectedSensitiveCount} 条公开敏感项待分级`
              : `${highRiskCount} 条高风险项已分级受控`,
        },
      ],
      recommendations,
    };
  }

  /**
   * 全库合规边界扫描（纯确定性、零高密正文泄漏）：
   * 自动对比当前知识库全部条款与已定义的权限模型、访问策略和检索隔离边界，
   * 识别疑似违规或存在泄露隐患的条款并生成可审计摘要。
   */
  scanComplianceRisks(params: {
    role: string;
    permissionModel: PermissionModel;
    policy: {
      enabled: boolean;
      min_level: number;
      classification: string;
      allowed_departments: string[];
      default_strict_mode: boolean;
      allow_llm: boolean;
    };
  }): RiskScanReport {
    const callerLevel = this.roleLevel(params.role);
    const verified = Boolean(params.permissionModel.may_claim_verified);
    const authority = params.permissionModel.authority;
    const compliance = this.evaluateCompliance({
      role: params.role,
      permissionModel: params.permissionModel,
      policy: params.policy,
    });

    const findings: RiskScanFinding[] = [];
    const flaggedClauseIds = new Set<string>();

    const safeExcerptFor = (obj: KnowledgeObject): string => {
      const vis = this.visibleContent(obj, params.role).trim();
      if (!vis) {
        return "[该条款正文超出当前身份权限，已在服务端脱敏隐藏]";
      }
      return vis.length > 90 ? `${vis.slice(0, 90)}…` : vis;
    };

    for (const obj of this.objects) {
      const title = obj.title ?? obj.id;
      const maxLevel = this.maxFieldLevel(obj);
      const l0Text = String(obj.levels?.["0"] ?? "");
      const matchedPublicTriggers = SENSITIVE_TRIGGER_TERMS.filter((term) =>
        l0Text.includes(term)
      );
      const excerpt = safeExcerptFor(obj);

      // 1. 公开层高敏词越界（L0 含处罚/追责/薪酬等表述且无高密级分层，或处于高密级知识库中未设保护）
      if (maxLevel === 0 && matchedPublicTriggers.length > 0) {
        flaggedClauseIds.add(obj.id);
        findings.push({
          finding_id: `${obj.id}:public_sensitive`,
          clause_id: obj.id,
          clause_title: title,
          max_level: maxLevel,
          severity: "high",
          rule_code: "public_sensitive_exposure",
          rule_label: "公开层高敏内容未分级",
          summary: `公开条款（L0）直接包含「${matchedPublicTriggers
            .slice(0, 3)
            .join("、")}」等敏感治理词汇，未设置 L1/L2 分级隔离边界。`,
          remediation:
            "建议将涉及处分、追责或薪酬细则的段落拆分至 [L1]/[L2] 密级，或在访问权限管理中提高整库最低准入级别。",
          safe_excerpt: excerpt,
          sample_probe_question: `关于「${title.slice(0, 18)}」，具体有哪些处罚或管理规定？`,
        });
      }

      // 2. 高密级（L2）条款的分层边界尚未经真实业务方确认
      if (maxLevel >= 2 && !verified && authority !== "standard") {
        flaggedClauseIds.add(obj.id);
        findings.push({
          finding_id: `${obj.id}:unverified_boundary`,
          clause_id: obj.id,
          clause_title: title,
          max_level: maxLevel,
          severity: "high",
          rule_code: "unverified_restricted_boundary",
          rule_label: "高密级分层边界待业务确认",
          summary:
            callerLevel < 2
              ? "该条款包含 L2 级高敏感受控细则（已按当前权限截断），但其权限分层仍标记为“提议值/未声明”，尚未经业务与法务签核。"
              : "该条款包含 L2 级红线与处置细则，但当前知识库权限分层仍为“提议值/未声明”，不符合正式上线合规边界要求。",
          remediation:
            "请由 HR / 法务核对 L0/L1/L2 切分边界并确认权限模型来源，避免误放行或过度拦截。",
          safe_excerpt:
            callerLevel < 2
              ? "[L2 级受控正文已按当前身份权限脱敏，仅展示边界合规状态]"
              : excerpt,
          sample_probe_question: `请问「${title.slice(0, 18)}」中涉及红线或细则的规定是什么？`,
        });
      }

      // 3. 非严格模式下，仅出现于高密级正文的关键词可能构成“存在性侧信道”暴露风险
      if (maxLevel > 0 && !params.policy.default_strict_mode) {
        const publicCorpus = `${title} ${l0Text}`;
        const hiddenOnlyKeywords = (obj.keywords ?? []).filter(
          (kw) => !publicCorpus.includes(kw)
        );
        if (hiddenOnlyKeywords.length > 0) {
          flaggedClauseIds.add(obj.id);
          findings.push({
            finding_id: `${obj.id}:keyword_leak_risk`,
            clause_id: obj.id,
            clause_title: title,
            max_level: maxLevel,
            severity: "medium",
            rule_code: "keyword_tier_leak_risk",
            rule_label: "非严格模式存在性推断风险",
            summary:
              callerLevel >= maxLevel
                ? `该条款有 ${hiddenOnlyKeywords.length} 个检索关键词仅出现于高于 L0 的密级正文；当前未开启强制严格隔离，低权限用户试探时可能推断出高密条款存在。`
                : "该条款存在仅关联高密级正文的索引边界；当前知识库未开启强制严格隔离，建议启用严格模式以防存在性探测。",
            remediation:
              "在「访问权限管理」中为该知识库开启「强制严格隔离（不披露存在性）」。",
            safe_excerpt: excerpt,
            sample_probe_question: `请问「${title.slice(0, 18)}」有哪些具体执行细则？`,
          });
        }
      }

      // 4. 高密级条款所在知识库允许外部 LLM 出网
      if (
        maxLevel >= 2 &&
        params.policy.allow_llm &&
        params.policy.classification !== "public"
      ) {
        flaggedClauseIds.add(obj.id);
        findings.push({
          finding_id: `${obj.id}:llm_egress`,
          clause_id: obj.id,
          clause_title: title,
          max_level: maxLevel,
          severity: "medium",
          rule_code: "high_tier_llm_egress",
          rule_label: "高密条款允许外发大模型整理",
          summary:
            "该条款含 L2 级受控内容，且当前知识库策略开启了外部 LLM 整理开关；虽然低权限查询会被截断，但高权限查询命中后正文可能进入外部模型上下文。",
          remediation:
            "若该知识库含内部保密红线，建议在「访问权限管理」中关闭「允许裁剪后上下文发往外部 LLM」，采用条款原文直出模式。",
          safe_excerpt:
            callerLevel < 2
              ? "[L2 级受控正文已按当前身份权限脱敏]"
              : excerpt,
          sample_probe_question: `请说明「${title.slice(0, 18)}」的完整制度条款。`,
        });
      }

      // 5. 缺少检索关键词锚点
      if ((obj.keywords ?? []).length === 0) {
        flaggedClauseIds.add(obj.id);
        findings.push({
          finding_id: `${obj.id}:missing_keywords`,
          clause_id: obj.id,
          clause_title: title,
          max_level: maxLevel,
          severity: "low",
          rule_code: "missing_retrieval_anchor",
          rule_label: "缺少确定性检索关键词",
          summary: "该条款未配置关键词锚点，纯依赖二元词组兜底召回，可能导致制度命中漏报。",
          remediation: "建议在源文档或飞书多维表格中补充 3~6 个核心业务关键词。",
          safe_excerpt: excerpt,
          sample_probe_question: `请问「${title.slice(0, 18)}」的相关规定是什么？`,
        });
      }
    }

    const severityRank: Record<RiskFindingSeverity, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };
    findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

    const highCount = findings.filter((f) => f.severity === "high").length;
    const mediumCount = findings.filter((f) => f.severity === "medium").length;
    const lowCount = findings.filter((f) => f.severity === "low").length;

    return {
      scanned_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      total_clauses: this.objects.length,
      flagged_clauses: flaggedClauseIds.size,
      total_findings: findings.length,
      high_count: highCount,
      medium_count: mediumCount,
      low_count: lowCount,
      compliance_score: compliance.overall_score,
      grade_label: compliance.grade_label,
      policy_snapshot: {
        min_level: params.policy.min_level,
        classification: params.policy.classification,
        default_strict_mode: params.policy.default_strict_mode,
        allow_llm: params.policy.allow_llm,
        allowed_departments: [...params.policy.allowed_departments],
      },
      findings,
    };
  }

  private probeCovered(question: string, hitContent: string): boolean {
    for (const [qKws, answerProbes] of this.probeRules) {
      if (qKws.some((kw) => question.includes(kw))) {
        return answerProbes.some((probe) => hitContent.includes(probe));
      }
    }
    return true;
  }

  private coveredWithFullAccess(question: string, oids: string[]): boolean {
    const byId = new Map(this.objects.map((o) => [o.id, o]));
    const parts: string[] = [];
    for (const oid of oids) {
      const obj = byId.get(oid);
      if (!obj) continue;
      const entries = Object.entries(obj.levels ?? {}).sort(
        (a, b) => Number(a[0]) - Number(b[0])
      );
      for (const [, content] of entries) {
        parts.push(String(content));
      }
    }
    return this.probeCovered(question, parts.join(" "));
  }

  searchPrecedents(question: string, topN = 2): PrecedentCase[] {
    const qTerms = extractTerms(question);
    const scored: Array<{ c: PrecedentCase; score: number }> = [];
    for (const c of this.cases) {
      const hay = `${c.topic ?? ""} ${c.question ?? ""} ${c.context ?? ""}`;
      const cTerms = extractTerms(hay);
      let hits = 0;
      for (const t of qTerms) {
        if (cTerms.has(t)) hits += 1;
      }
      if (hits >= 1) {
        scored.push({ c, score: hits });
      }
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map((s) => s.c);
  }

  private visibleCandidates(role: string, correctedQuestion: string): SemanticCandidate[] {
    const candidates: SemanticCandidate[] = [];
    for (const obj of this.objects) {
      const vis = this.visibleContent(obj, role);
      if (vis) {
        candidates.push({
          id: obj.id,
          title: obj.title ?? obj.id,
          content: vis,
        });
      }
    }
    const backend = this.semanticBackend;
    if (backend && candidates.length > backend.maxCandidates) {
      const kw = new Set(
        this.retrieve(correctedQuestion, backend.maxCandidates, this.roleLevel(role)).ids
      );
      const filtered = candidates.filter((c) => kw.has(c.id));
      if (filtered.length > 0) {
        return filtered;
      }
      return candidates.slice(0, backend.maxCandidates);
    }
    return candidates;
  }

  private candidatesForIds(role: string, ids: string[]): SemanticCandidate[] {
    const byId = new Map(this.objects.map((o) => [o.id, o]));
    const out: SemanticCandidate[] = [];
    for (const oid of ids) {
      const obj = byId.get(oid);
      if (!obj) continue;
      const vis = this.visibleContent(obj, role);
      if (vis) {
        out.push({ id: oid, title: obj.title ?? oid, content: vis });
      }
    }
    return out;
  }

  async answer(
    question: string,
    role: string,
    options?: { strictMode?: boolean }
  ): Promise<GovAnswer> {
    const strict =
      options?.strictMode !== undefined
        ? Boolean(options.strictMode)
        : this.strictNonexistenceDisclosure;

    const ans: GovAnswer = {
      question,
      role,
      hit_ids: [],
      visible_texts: {},
      denied_fields: [],
      verdict: "covered",
      precedents: [],
      boundary_note: "",
      typo_corrections: [],
      semantic_used: false,
      retrieval_mode: "keyword",
      strict_mode: strict,
      gap_reason: "",
    };

    const [corrected, corrections] = this.correctTypos(question);
    ans.typo_corrections = corrections;

    const retrievalLvl = strict ? this.roleLevel(role) : null;
    const backendReady =
      this.semanticBackend !== null &&
      this.semanticBackend.available &&
      this.retrievalPreference !== "local";

    let semanticResult: SemanticResult | null = null;
    if (backendReady && this.semanticBackend) {
      const candidates = this.visibleCandidates(role, corrected);
      semanticResult = await this.semanticBackend.match(corrected, candidates);
    }

    let hitIds: string[];
    const byId = new Map(this.objects.map((o) => [o.id, o]));

    if (semanticResult !== null) {
      hitIds = semanticResult.relevantIds.filter((id) => byId.has(id));
      ans.semantic_used = true;
      ans.retrieval_mode = "llm";
    } else {
      const ret = this.retrieve(corrected, 3, retrievalLvl);
      hitIds = ret.ids;
      ans.retrieval_mode = ret.usedBigram ? "hybrid" : "keyword";

      if (
        this.retrievalPreference === "local" &&
        hitIds.length > 0 &&
        this.semanticBackend !== null &&
        this.semanticBackend.available
      ) {
        const coverage = await this.semanticBackend.match(
          corrected,
          this.candidatesForIds(role, hitIds)
        );
        if (coverage !== null) {
          semanticResult = coverage;
          ans.semantic_used = true;
        }
      }
    }

    ans.hit_ids = hitIds;

    if (hitIds.length === 0) {
      const rawHits = this.retrieve(corrected, 3, retrievalLvl).ids;
      const restrictedHits = strict
        ? []
        : rawHits.filter((oid) => {
            const obj = byId.get(oid);
            return obj ? this.maxFieldLevel(obj) > this.roleLevel(role) : false;
          });
      if (restrictedHits.length > 0) {
        ans.verdict = "restricted";
        ans.hit_ids = restrictedHits;
        ans.denied_fields = [...restrictedHits];
        for (const oid of restrictedHits) {
          const obj = byId.get(oid);
          if (obj) {
            ans.visible_texts[oid] = this.visibleContent(obj, role);
          }
        }
        ans.boundary_note =
          "该问题涉及的信息超出你的角色权限范围，未向你展示；如需了解请联系 HR 或管理员查询。";
        if (corrections.length > 0) {
          ans.boundary_note +=
            " 已将输入中的 " + corrections.join("、") + " 按制度用词理解。";
        }
        return ans;
      }
      ans.verdict = "out_of_scope";
      ans.precedents = this.searchPrecedents(corrected);
      if (strict) {
        ans.boundary_note =
          "在你可见的权限范围内没有对应条款（严格隔离模式不披露高密级条款是否存在），如需确认请联系 HR。";
      } else {
        ans.boundary_note = "问题不在已登记知识范围内，建议升级人工确认。";
      }
      return ans;
    }

    // 字段级权限 + 覆盖判定
    const level = this.roleLevel(role);
    for (const oid of hitIds) {
      const obj = byId.get(oid);
      if (!obj) continue;
      const maxLevel = this.maxFieldLevel(obj);
      const vis = this.visibleContent(obj, role);
      ans.visible_texts[oid] = vis;
      if (maxLevel > level) {
        if (!strict) {
          ans.denied_fields.push(oid);
        }
        if (!vis) {
          if (!strict) {
            ans.boundary_note = `命中条目 [${obj.id}] 的内容级别为 ${maxLevel}，你的角色 [${role}] 级别 ${level} 无查看权限。`;
          }
          continue;
        }
      }
      let covered: boolean;
      if (semanticResult !== null) {
        covered = semanticResult.covered;
        if (!covered && semanticResult.missing) {
          ans.gap_reason = semanticResult.missing;
        }
      } else {
        covered = this.probeCovered(corrected, vis);
      }
      if (!covered) {
        ans.verdict = "gap";
      }
    }

    const hasAnyVisible = Object.values(ans.visible_texts).some((v) => Boolean(v));
    if (ans.verdict === "covered" && ans.denied_fields.length > 0 && !hasAnyVisible) {
      if (!strict && this.coveredWithFullAccess(corrected, ans.denied_fields)) {
        ans.verdict = "restricted";
        ans.boundary_note =
          "制度中有相关规定，但超出你的角色权限范围，未向你展示；如需了解请联系 HR 或管理员查询。";
      } else {
        ans.verdict = "out_of_scope";
        ans.boundary_note = strict
          ? "在你可见的权限范围内没有对应条款，如需确认请联系 HR。"
          : "问题不在已登记知识范围内，建议升级人工。";
      }
    }

    ans.precedents = this.searchPrecedents(corrected);

    if (ans.verdict === "gap") {
      if (
        !strict &&
        ans.denied_fields.length > 0 &&
        this.coveredWithFullAccess(corrected, ans.denied_fields)
      ) {
        ans.verdict = "restricted";
        ans.boundary_note =
          "制度中有相关规定，但超出你的角色权限范围，未向你展示；如需了解请联系 HR 或管理员查询。";
      } else {
        const reason = ans.gap_reason ? `（缺少：${ans.gap_reason}）` : "";
        if (ans.precedents.length > 0) {
          ans.boundary_note = `知识未覆盖此问题${reason}，但有过往先例可参考（仅供参考，以实际确认为准）。`;
        } else {
          ans.boundary_note = `知识未覆盖此问题${reason}，且无过往先例。系统不编造规则：建议升级人工裁决，裁决后将沉淀为先例。`;
        }
      }
    } else if (ans.denied_fields.length > 0 && !ans.boundary_note) {
      ans.boundary_note = strict
        ? "已返回你可见范围内的全部条款。"
        : "已返回你可视范围内内容；命中条目含更高权限字段，未向你展示。";
    }

    if (corrections.length > 0) {
      const hint = "已将输入中的 " + corrections.join("、") + " 按制度用词理解。";
      ans.boundary_note = (ans.boundary_note + " " + hint).trim();
    }

    return ans;
  }

  /**
   * 实时输入预检（纯确定性、无模型外发、零高密正文泄漏）：
   * 仅在标准模式下由服务端调用，判断当前输入是否触及高于调用方权限的受控字段。
   */
  preflight(question: string, role: string): PreflightResult {
    const callerLevel = this.roleLevel(role);
    const [corrected, typoCorrections] = this.correctTypos(question);
    const { ids: hitIds } = this.retrieve(corrected, 3, null);

    if (hitIds.length === 0) {
      return {
        status: "clear",
        caller_level: callerLevel,
        required_level: callerLevel,
        affected_count: 0,
        typo_corrections: typoCorrections,
      };
    }

    const byId = new Map(this.objects.map((o) => [o.id, o]));
    const higherTierIds: string[] = [];
    let maxMatchedLevel = callerLevel;
    let hasAnyVisible = false;
    let visibleCovered = true;

    for (const oid of hitIds) {
      const obj = byId.get(oid);
      if (!obj) continue;
      const objMax = this.maxFieldLevel(obj);
      const vis = this.visibleContent(obj, role);
      if (vis) {
        hasAnyVisible = true;
        if (!this.probeCovered(corrected, vis)) {
          visibleCovered = false;
        }
      }
      if (objMax > callerLevel) {
        higherTierIds.push(oid);
        if (objMax > maxMatchedLevel) {
          maxMatchedLevel = objMax;
        }
      }
    }

    if (higherTierIds.length === 0) {
      return {
        status: "clear",
        caller_level: callerLevel,
        required_level: callerLevel,
        affected_count: 0,
        typo_corrections: typoCorrections,
      };
    }

    // Check if the answer strictly resides in higher-level tiers (fully restricted)
    const fullCovered = this.coveredWithFullAccess(corrected, higherTierIds);
    const isFullyRestricted = (!hasAnyVisible || !visibleCovered) && fullCovered;

    let requiredLevel = maxMatchedLevel;
    if (isFullyRestricted) {
      // Determine the lowest tier above callerLevel that satisfies coverage
      for (let lvl = callerLevel + 1; lvl <= maxMatchedLevel; lvl += 1) {
        const parts: string[] = [];
        for (const oid of higherTierIds) {
          const obj = byId.get(oid);
          if (!obj) continue;
          for (const [k, content] of Object.entries(obj.levels ?? {})) {
            if (Number(k) <= lvl) {
              parts.push(String(content));
            }
          }
        }
        if (parts.length > 0 && this.probeCovered(corrected, parts.join(" "))) {
          requiredLevel = lvl;
          break;
        }
      }
    }

    return {
      status: isFullyRestricted ? "restricted" : "partial_restricted",
      caller_level: callerLevel,
      required_level: requiredLevel,
      affected_count: higherTierIds.length,
      typo_corrections: typoCorrections,
    };
  }

  addPrecedent(params: {
    topic: string;
    question: string;
    context: string;
    ruling: string;
    reasoning: string;
    approver: string;
    department?: string;
    case_id?: string;
    date?: string;
  }): PrecedentCase {
    const now = new Date();
    const year = now.getFullYear();
    const date = params.date ?? now.toISOString().slice(0, 10);
    const num = String(100 + this.cases.length).padStart(3, "0");
    const c: PrecedentCase = {
      case_id: params.case_id ?? `C-${year}-${num}`,
      topic: params.topic,
      question: params.question,
      context: params.context,
      ruling: params.ruling,
      reasoning: params.reasoning,
      approver: params.approver,
      department: params.department ?? "",
      date,
      status: "closed",
      reference_only: true,
    };
    this.cases.push(c);
    return c;
  }
}

export function normalizePermissionModel(
  raw: Record<string, unknown> | null | undefined
): PermissionModel {
  if (!raw) {
    return {
      authority: "unlabeled",
      source: "该数据集未声明分层来源",
      warning: "分层来源不明，应视为提议值；不得据此宣称权限隔离已验证",
      may_claim_verified: false,
    };
  }
  const authority =
    typeof raw.authority === "string" && raw.authority ? raw.authority : "unlabeled";
  const source = typeof raw.source === "string" ? raw.source : "";
  const warning = typeof raw.warning === "string" ? raw.warning : "";
  const pm: PermissionModel = {
    ...raw,
    authority,
    source,
    warning,
    may_claim_verified: Boolean(raw.may_claim_verified) && authority === "customer",
  };
  return pm;
}

export function loadDataset(datasetPath: string): DatasetSpec {
  const data = JSON.parse(fs.readFileSync(datasetPath, "utf-8")) as {
    dataset?: string;
    name?: string;
    description?: string;
    objects?: KnowledgeObject[];
    roles?: Record<string, number>;
    probe_rules?: ProbeRule[];
    precedent_cases?: PrecedentCase[];
    permission_model?: Record<string, unknown>;
    feishu_meta?: FeishuMeta;
  };
  return {
    dataset: data.dataset ?? "",
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : undefined,
    description: data.description ?? "",
    objects: data.objects ?? [],
    roles: data.roles ?? { user: 0 },
    probe_rules: data.probe_rules ?? [],
    cases: data.precedent_cases ?? [],
    permission_model: normalizePermissionModel(data.permission_model),
    feishu_meta: data.feishu_meta,
  };
}
