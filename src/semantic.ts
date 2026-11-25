/**
 * LLM 语义后端：用大模型做「语义匹配 + 覆盖判定」，无 API key 或调用失败时自动降级返回 null。
 */

import crypto from "node:crypto";

const API_URL = "https://api.deepseek.com/chat/completions";
const API_MODEL = "deepseek-chat";

const SYSTEM_PROMPT = `你是企业知识库的检索与覆盖判定助手。给定一个员工问题和若干制度条款，你需要：
1. 判断哪些条款与问题**语义相关**（即使措辞不同也算相关，例如"什么时候会被开除"与"予以劝退"相关）；
2. 判断这些相关条款是否**明确回答**了问题（有具体规则/标准/流程即为明确回答；只有泛泛表述则不算）。

只输出 JSON，不要任何其他文字：
{"relevant": ["条款id", ...], "covered": true 或 false, "missing": "若未覆盖，一句话说明缺少什么规则"}`;

export interface SemanticCandidate {
  id: string;
  title: string;
  content: string;
}

export interface SemanticResult {
  relevantIds: string[];
  covered: boolean;
  missing: string;
  cached: boolean;
}

export class LLMSemanticBackend {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxCandidates: number;
  private cache = new Map<string, SemanticResult>();
  calls = 0;
  cacheHits = 0;

  constructor(options?: {
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
    maxCandidates?: number;
  }) {
    this.apiKey =
      options?.apiKey !== undefined
        ? options.apiKey
        : (process.env.DEEPSEEK_API_KEY ?? "");
    this.model = options?.model ?? API_MODEL;
    this.timeoutMs = options?.timeoutMs ?? 30_000;
    this.maxCandidates = options?.maxCandidates ?? 20;
  }

  get available(): boolean {
    return Boolean(this.apiKey);
  }

  async match(
    question: string,
    candidates: SemanticCandidate[],
    filterFn?: (content: string) => string
  ): Promise<SemanticResult | null> {
    if (!this.available || candidates.length === 0) {
      return null;
    }
    const trimmed = candidates.slice(0, this.maxCandidates);
    const keySrc =
      question +
      "|" +
      trimmed
        .map((c) => {
          const hash = crypto
            .createHash("md5")
            .update(c.content, "utf-8")
            .digest("hex")
            .slice(0, 8);
          return `${c.id}:${hash}`;
        })
        .join("|");
    const key = crypto.createHash("md5").update(keySrc, "utf-8").digest("hex");

    const cached = this.cache.get(key);
    if (cached) {
      this.cacheHits += 1;
      return { ...cached, cached: true };
    }

    const blocks = trimmed.map((c) => {
      const content = filterFn ? filterFn(c.content) : c.content;
      return `[${c.id}] 标题：${c.title}\n内容：${content}`;
    });
    const userPrompt = `【员工问题】${question}\n\n【候选条款】\n${blocks.join("\n\n")}`;

    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.0,
          max_tokens: 300,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      this.calls += 1;
      if (!resp.ok) {
        return null;
      }
      const payload = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = payload.choices?.[0]?.message?.content?.trim() ?? "";
      const result = LLMSemanticBackend.parse(text);
      if (!result) {
        return null;
      }
      this.cache.set(key, result);
      return result;
    } catch {
      return null;
    }
  }

  static parse(text: string): SemanticResult | null {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) {
      return null;
    }
    try {
      const data = JSON.parse(m[0]) as {
        relevant?: unknown;
        covered?: unknown;
        missing?: unknown;
      };
      let ids: string[] = [];
      if (Array.isArray(data.relevant)) {
        ids = data.relevant.map((i) => String(i));
      } else if (data.relevant !== undefined && data.relevant !== null) {
        ids = [String(data.relevant)];
      }
      return {
        relevantIds: ids,
        covered: Boolean(data.covered),
        missing: data.missing ? String(data.missing) : "",
        cached: false,
      };
    } catch {
      return null;
    }
  }
}
