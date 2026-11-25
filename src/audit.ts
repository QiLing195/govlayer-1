/**
 * 审计日志：追加式 JSONL + 内存环形缓冲 + 合规 CSV 导出。
 * 绝不落原始令牌，只存 SHA-256 前 12 位指纹；写盘失败不影响业务请求。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const AUDIT_PATH_ENV = "GOVLAYER_AUDIT_LOG";
const AUDIT_REDACT_ENV = "GOVLAYER_AUDIT_REDACT";
const RING_SIZE = 2000;
const MAX_LIMIT = 500;

export interface AuditRecord {
  audit_id?: string;
  ts?: string;
  event?: string;
  dataset?: string;
  token_fp?: string;
  question?: string;
  question_redacted?: boolean;
  question_sha256?: string;
  question_len?: number;
  question_withheld?: string;
  identity_label?: string;
  department?: string;
  level?: number;
  role?: string;
  verdict?: string;
  reason?: string;
  scope?: string;
  status?: number;
  hit_ids?: string[];
  denied_fields?: string[];
  n_sources?: number;
  semantic_used?: boolean;
  retrieval_mode?: string;
  strict_mode?: boolean;
  llm_used?: boolean;
  typo_corrections?: string[];
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

function isRedactEnabled(): boolean {
  const val = process.env[AUDIT_REDACT_ENV] ?? "";
  return val === "1" || val === "true" || val === "True";
}

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function tokenFingerprint(token: string | undefined | null): string {
  if (!token) {
    return "none";
  }
  return crypto.createHash("sha256").update(token, "utf-8").digest("hex").slice(0, 12);
}

export function questionField(question: string): Partial<AuditRecord> {
  if (isRedactEnabled()) {
    return {
      question_redacted: true,
      question_sha256: crypto
        .createHash("sha256")
        .update(question, "utf-8")
        .digest("hex")
        .slice(0, 16),
      question_len: question.length,
    };
  }
  return { question };
}

function csvSafeCell(value: unknown): string {
  let str = String(value ?? "");
  // Prevent CSV formula injection in spreadsheet tools
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

export class AuditLog {
  readonly logPath: string;
  readonly displayPath: string;
  private ring: AuditRecord[] = [];
  writeErrors = 0;
  written = 0;
  loadedFromDisk = 0;

  constructor(customPath?: string) {
    const cwd = process.cwd();
    const defaultPath = path.resolve(cwd, "audit", "audit.jsonl");
    const envPath = (process.env[AUDIT_PATH_ENV] ?? "").trim();
    this.logPath = path.resolve(customPath || envPath || defaultPath);
    const rel = path.relative(cwd, this.logPath);
    this.displayPath = rel && !rel.startsWith("..") ? rel : path.basename(this.logPath);
    this.loadExisting();
  }

  private loadExisting(): void {
    try {
      if (!fs.existsSync(this.logPath)) {
        return;
      }
      const raw = fs.readFileSync(this.logPath, "utf-8");
      const lines = raw.split(/\r?\n/);
      const tailLines = lines.slice(-RING_SIZE);
      for (const line of tailLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as AuditRecord;
          this.ring.push(parsed);
          if (this.ring.length > RING_SIZE) {
            this.ring.shift();
          }
          this.loadedFromDisk += 1;
        } catch {
          // Tolerate malformed lines
        }
      }
    } catch {
      // Unreadable audit file does not block startup
    }
  }

  record(rec: AuditRecord): AuditRecord {
    const entry: AuditRecord = {
      audit_id: rec.audit_id ?? `aud_${crypto.randomBytes(6).toString("hex")}`,
      ts: utcNow(),
      ...rec,
      event: rec.event ?? "error",
    };
    this.ring.push(entry);
    if (this.ring.length > RING_SIZE) {
      this.ring.shift();
    }
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + "\n", "utf-8");
      this.written += 1;
    } catch {
      this.writeErrors += 1;
    }
    return entry;
  }

  tail(limit = 50, event?: string | null): AuditRecord[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(Number(limit) || 50), MAX_LIMIT));
    const items = event ? this.ring.filter((e) => e.event === event) : this.ring;
    return items.slice(-safeLimit).reverse();
  }

  toCsv(limit = 500, event?: string | null): string {
    const rows = this.tail(limit, event);
    const header = [
      "audit_id",
      "ts_utc",
      "event",
      "status",
      "dataset",
      "identity",
      "department",
      "level",
      "role",
      "token_fp",
      "verdict",
      "denied_fields",
      "question_or_resource",
      "reason",
      "latency_ms",
    ];
    const lines = [header.join(",")];
    for (const r of rows) {
      const detail = r.question
        ? r.question
        : r.question_sha256
        ? `sha256:${r.question_sha256}`
        : r.resource
        ? `${r.resource} ${r.action ?? ""}`.trim()
        : "";
      lines.push(
        [
          r.audit_id ?? "",
          r.ts ?? "",
          r.event ?? "",
          r.status ?? "",
          r.dataset ?? "",
          r.identity_label ?? "",
          r.department ?? "",
          r.level ?? "",
          r.role ?? "",
          r.token_fp ?? "",
          r.verdict ?? "",
          (r.denied_fields ?? []).join("|"),
          detail || r.question_withheld || "",
          r.reason ?? "",
          r.latency_ms ?? "",
        ]
          .map(csvSafeCell)
          .join(",")
      );
    }
    return "\uFEFF" + lines.join("\n");
  }

  stats(): AuditStats {
    const items = this.ring;
    const byVerdict: Record<string, number> = {};
    const byEvent: Record<string, number> = {};
    const byRole: Record<string, number> = {};
    const latencies: number[] = [];
    const fps = new Set<string>();

    for (const e of items) {
      if (e.verdict) {
        byVerdict[e.verdict] = (byVerdict[e.verdict] ?? 0) + 1;
      }
      const ev = e.event ?? "error";
      byEvent[ev] = (byEvent[ev] ?? 0) + 1;
      if (e.role) {
        byRole[e.role] = (byRole[e.role] ?? 0) + 1;
      }
      if (typeof e.latency_ms === "number" && Number.isFinite(e.latency_ms)) {
        latencies.push(e.latency_ms);
      }
      if (e.token_fp && e.token_fp !== "none") {
        fps.add(e.token_fp);
      }
    }

    const avg =
      latencies.length > 0
        ? Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 10) / 10
        : null;
    const maxLat = latencies.length > 0 ? Math.max(...latencies) : null;

    return {
      total: items.length,
      written_to_disk: this.loadedFromDisk + this.written,
      loaded_from_disk: this.loadedFromDisk,
      written_this_session: this.written,
      write_errors: this.writeErrors,
      log_path: this.displayPath,
      by_event: byEvent,
      by_verdict: byVerdict,
      by_role: byRole,
      auth_failures: byEvent["auth_failed"] ?? 0,
      unique_token_fingerprints: fps.size,
      latency_ms_avg: avg,
      latency_ms_max: maxLat,
      first_ts: items.length > 0 ? (items[0].ts ?? null) : null,
      last_ts: items.length > 0 ? (items[items.length - 1].ts ?? null) : null,
      redact_questions: isRedactEnabled(),
    };
  }
}
