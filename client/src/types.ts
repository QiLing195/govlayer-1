export interface PermissionModel {
  authority: "customer" | "standard" | "proposed" | "unlabeled" | string;
  source: string;
  principle?: string;
  warning: string;
  may_claim_verified: boolean;
}

export interface SamplePrompt {
  label: string;
  question: string;
  intent: string;
}

export type DataClassification = "public" | "internal" | "confidential" | "restricted";
export type SourceType = "local" | "feishu_wiki" | "feishu_bitable" | "feishu_doc";

export interface FeishuMeta {
  source_type?: "feishu_wiki" | "feishu_bitable" | "feishu_doc";
  space_id?: string;
  app_token?: string;
  table_id?: string;
  synced_at?: string;
  node_count?: number;
}

export interface KnowledgeBasePolicy {
  dataset_id: string;
  enabled: boolean;
  min_level: number;
  allowed_departments: string[];
  classification: DataClassification;
  source_type: SourceType;
  default_strict_mode: boolean;
  allow_llm: boolean;
  allow_precedent_read: number;
  updated_at: string;
  updated_by: string;
}

export interface KnowledgeBasePolicyItem extends KnowledgeBasePolicy {
  name: string;
  n_objects: number;
  roles: Record<string, number>;
}

export interface PoliciesResponse {
  can_manage: boolean;
  caller_level: number;
  caller_identity: string;
  caller_department: string;
  auditor_level: number;
  departments: string[];
  knowledge_bases: KnowledgeBasePolicyItem[];
}

export interface FeishuStatus {
  configured: boolean;
  domain: string;
  default_space_id: string;
  app_id_masked: string;
  can_manage: boolean;
  departments: string[];
}

export interface FeishuWikiSpace {
  space_id: string;
  name: string;
  description: string;
  visibility?: string;
}

export interface DatasetMeta {
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
  policy?: KnowledgeBasePolicy;
}

export interface TokenOption {
  token: string;
  label: string;
  level: number;
  department: string;
  role_tag: string;
}

export interface TokensResponse {
  demo_mode: boolean;
  tokens: TokenOption[];
}

export type Verdict = "covered" | "restricted" | "gap" | "out_of_scope";

export interface VisibleSource {
  id: string;
  title: string;
  content: string;
}

export interface PrecedentCase {
  case_id: string;
  topic: string;
  question?: string;
  context?: string;
  ruling: string;
  reasoning?: string;
  approver: string;
  department?: string;
  date: string;
  status?: string;
  reference_only?: boolean;
}

export interface AskResponse {
  audit_id?: string;
  dataset?: string;
  question: string;
  role: string;
  level: number;
  department?: string;
  verdict: Verdict;
  allowed_to_call_llm?: boolean;
  safe_context?: string;
  answer_text: string;
  visible_sources: VisibleSource[];
  denied_fields: string[];
  precedents: PrecedentCase[];
  boundary_note: string;
  typo_corrections: string[];
  semantic_used: boolean;
  retrieval_mode: "keyword" | "hybrid" | "llm";
  strict_mode: boolean;
  identity: string;
  llm_used: boolean;
  latency_ms: number;
}

export interface GatewayGovernResponse extends AskResponse {
  audit_id: string;
  dataset: string;
  department: string;
  allowed_to_call_llm: boolean;
  safe_context: string;
}

export type PreflightStatus =
  | "clear"
  | "partial_restricted"
  | "restricted"
  | "blocked"
  | "strict_suppressed";

export interface PreflightResponse {
  status: PreflightStatus;
  risk_level: "none" | "medium" | "high";
  reason?: string;
  caller_level: number;
  required_level: number;
  affected_count: number;
  strict_suppressed: boolean;
  typo_corrections: string[];
  warning_title: string;
  warning_detail: string;
}

export type ClauseRiskLevel = "high" | "medium" | "low";

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

export interface ClausesResponse {
  dataset: string;
  role: string;
  level: number;
  department?: string;
  identity: string;
  compliance: ComplianceSummary;
  clauses: VisibleClause[];
}

export type RiskFindingSeverity = "high" | "medium" | "low";

export interface RiskScanFinding {
  finding_id: string;
  clause_id: string;
  clause_title: string;
  max_level: number;
  severity: RiskFindingSeverity;
  rule_code: string;
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

export interface RiskScanResponse {
  dataset: string;
  dataset_name: string;
  role: string;
  level: number;
  identity: string;
  report: RiskScanReport;
}

export interface PrecedentsResponse {
  dataset: string;
  can_manage: boolean;
  precedents: PrecedentCase[];
}

export interface AuditRecord {
  audit_id?: string;
  ts?: string;
  event?: string;
  dataset?: string;
  token_fp?: string;
  question?: string;
  question_sha256?: string;
  question_withheld?: string;
  identity_label?: string;
  department?: string;
  level?: number;
  role?: string;
  verdict?: string;
  reason?: string;
  scope?: string;
  status?: number;
  denied_fields?: string[];
  strict_mode?: boolean;
  case_id?: string;
  resource?: string;
  action?: string;
  latency_ms?: number;
}

export interface AuditStats {
  total: number;
  written_to_disk: number;
  loaded_from_disk: number;
  written_this_session: number;
  write_errors: number;
  log_path: string;
  by_event: Record<string, number>;
  by_verdict: Record<string, number>;
  by_role: Record<string, number>;
  auth_failures: number;
  unique_token_fingerprints: number;
  latency_ms_avg: number | null;
  latency_ms_max: number | null;
  first_ts: string | null;
  last_ts: string | null;
  redact_questions: boolean;
}

export interface AuditResponse {
  records: AuditRecord[];
  stats: AuditStats;
}
