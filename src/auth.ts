/**
 * 服务端身份解析（RBAC + ABAC）：
 * 把「客户端声称的角色」改为「服务端签发的令牌 → 权限级别 + 部门属性」。
 *
 * - 支持 X-API-Token 与标准 Authorization: Bearer <token>（兼容网关与 OpenAI SDK）；
 * - 当未配置 GOVLAYER_TOKENS 时，使用内置演示令牌；
 * - 当配置 GOVLAYER_TOKENS 后，演示令牌自动失效且 /api/tokens 不再对外暴露任何凭证；
 * - 请求体里的 role / department 字段一律忽略，防止客户端越权伪造。
 */

export interface TokenInfo {
  level: number;
  label: string;
  department: string;
  role_tag?: string;
}

export interface Identity {
  level: number;
  label: string;
  department: string;
  role_tag: string;
  token: string;
}

export const DEMO_TOKENS: Record<string, TokenInfo> = {
  "demo-l0-employee": {
    level: 0,
    label: "普通员工",
    department: "产品研发部",
    role_tag: "staff",
  },
  "demo-l1-manager": {
    level: 1,
    label: "研发部经理",
    department: "产品研发部",
    role_tag: "manager",
  },
  "demo-l1-hrbp": {
    level: 1,
    label: "HRBP",
    department: "人力资源部",
    role_tag: "hr_bp",
  },
  "demo-l2-hr": {
    level: 2,
    label: "HR / 合规审计员",
    department: "人力资源部",
    role_tag: "auditor",
  },
};

export const DEFAULT_DEPARTMENTS = [
  "产品研发部",
  "人力资源部",
  "财务与法务部",
  "行政与教务部",
];

const TOKEN_ENV = "GOVLAYER_TOKENS";
const DEV_MODE_ENV = "GOVLAYER_DEV_MODE";

function parseCustomTokens(): Record<string, TokenInfo> | null {
  const raw = (process.env[TOKEN_ENV] ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<TokenInfo>>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const cleaned: Record<string, TokenInfo> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k && v && typeof v === "object" && Number.isFinite(Number(v.level))) {
          cleaned[k] = {
            level: Number(v.level),
            label: String(v.label ?? `level-${v.level}`),
            department: String(v.department ?? "未分配部门"),
            role_tag: String(v.role_tag ?? `l${v.level}`),
          };
        }
      }
      if (Object.keys(cleaned).length > 0) {
        return cleaned;
      }
    }
  } catch {
    // Ignore malformed override
  }
  return null;
}

export function isDemoTokensActive(): boolean {
  return parseCustomTokens() === null;
}

function getTokens(): Record<string, TokenInfo> {
  return parseCustomTokens() ?? DEMO_TOKENS;
}

export function devMode(): boolean {
  const val = process.env[DEV_MODE_ENV] ?? "";
  return val === "1" || val === "true" || val === "True";
}

export function extractTokenFromHeaders(
  apiTokenHeader: string | undefined,
  authorizationHeader: string | undefined
): string | undefined {
  if (apiTokenHeader && apiTokenHeader.trim()) {
    return apiTokenHeader.trim();
  }
  if (authorizationHeader) {
    const m = authorizationHeader.trim().match(/^Bearer\s+(.+)$/i);
    if (m && m[1]?.trim()) {
      return m[1].trim();
    }
  }
  return undefined;
}

export function resolveIdentity(
  token: string | undefined | null,
  _claimedRole: string | undefined | null,
  roleLevels: Record<string, number>
): Identity | null {
  if (token) {
    const info = getTokens()[token];
    if (info !== undefined) {
      return {
        level: Number(info.level),
        label: String(info.label ?? `level-${info.level}`),
        department: String(info.department ?? "未分配部门"),
        role_tag: String(info.role_tag ?? `l${info.level}`),
        token,
      };
    }
    return null;
  }
  if (devMode()) {
    const levels = Object.values(roleLevels);
    const lowest = levels.length > 0 ? Math.min(...levels) : 0;
    return {
      level: lowest,
      label: "匿名（dev 模式·最低权限）",
      department: "外部访客",
      role_tag: "guest",
      token: "",
    };
  }
  return null;
}

export function roleForLevel(
  roleLevels: Record<string, number>,
  level: number
): string | null {
  let bestRole: string | null = null;
  let bestLevel = -Infinity;
  for (const [role, lvl] of Object.entries(roleLevels)) {
    if (
      lvl <= level &&
      (lvl > bestLevel || (lvl === bestLevel && bestRole !== null && role > bestRole))
    ) {
      bestLevel = lvl;
      bestRole = role;
    }
  }
  return bestRole;
}
