# GovLayer · 飞书数据源企业知识治理网关

面向企业知识库与 RAG 链路的确定性合规治理前置层：**飞书开放平台数据源直连**、**RBAC + ABAC 访问控制**、**L0/L1/L2 字段级硬裁剪**、**防存在性推断的严格隔离模式**、**输入期实时合规预警**、**可视化合规评分看板与一键全库风险扫描**、**OpenAI 兼容治理代理**以及**防公式注入的合规审计留痕**。

## 架构概览

```text
飞书开放平台 (Wiki / Bitable / 分层文档)        企业应用 / 飞书机器人 / Dify / OpenAI SDK
                  │                                                 │
                  ▼ (仅服务端读取 FEISHU_APP_SECRET)                 ▼ (X-API-Token / Bearer)
      ┌─────────────────────────────────────────────────────────────────────────┐
      │                    GovLayer 确定性治理网关 (Express + TS)                │
      │                                                                         │
      │  1. 服务端令牌解析 (RBAC 角色级别 + ABAC 部门属性，拒绝客户端伪造角色)    │
      │  2. 知识库准入策略门控 (启用状态 / 最低级别 / 部门边界 / LLM 出网开关)     │
      │  3. 字段级权限裁剪 + 严格隔离模式 (检索期按密级分区，防关键词侧信道探测)  │
      │  4. 四态诚实判定: covered | restricted | gap | out_of_scope             │
      │  5. 事前预检 (/api/preflight) + 一键全库风险扫描 + 合规评分引擎          │
      │  6. 审计留痕 (仅落 SHA-256 令牌指纹 · JSONL 持久化 · 防公式注入 CSV 导出) │
      └───────────────────────────────┬─────────────────────────────────────────┘
                                      │ 仅当 covered 且策略放行时输出 safe_context
                                      ▼
                        可选外部大模型整理 (DeepSeek) / 原文直出
```

## 核心功能

- **治理问答台（`QueryConsole`）**
  - 按服务端令牌执行字段级裁剪，同一问题对 L0 / L1 / L2 返回严格隔离的可见范围；
  - **实时输入合规预检（`/api/preflight`）**：用户输入时即时提示权限越界或分级截断风险（零高密正文泄露，严格模式下自动静默防探测）；
  - **一键全库风险扫描**：对比当前知识库与合规边界，在右侧抽屉展示疑似违规条款摘要、整改建议与一键代入验证。
- **条款与权限边界看板（`ClauseExplorer`）**
  - **制度合规性得分可视化看板**：按权限分级确认度、准入策略、规则完整度、高风险受控度四维实时评分（0–100）；
  - **高风险条款自动高亮**：自动标红含 L2 红线细则或公开层含处罚/追责/薪酬表述且未分级的条款。
- **访问权限管理（RBAC + ABAC）**
  - 按知识库实时配置最低准入级别、允许访问部门（ABAC）、密级分类、强制严格隔离与外部 LLM 出网策略，并持久化至 `audit/policies.json`。
- **飞书数据源与可插拔治理网关**
  - 直连同步飞书知识空间（Wiki/Docx）、多维表格（Bitable）及组织部门，或导入含 `[L0]/[L1]/[L2]` 标签的飞书 Markdown 文档热加载；
  - 提供 `POST /api/v1/gateway/govern` 与 OpenAI 兼容代理 `POST /api/v1/chat/completions`（`model: "govlayer:<dataset_id>"`），在 `restricted` / `gap` 判定下硬阻断大模型调用。
- **先例闭环与合规审计**
  - 制度空白支持 L2 管理员人工裁决并沉淀为历史先例（`audit/precedents.jsonl`）；
  - 审计接口自身受 L2 门控，支持按事件筛选及防公式注入的合规 CSV 报表导出。

## 主要接口速览

| 方法与路径 | 说明 | 权限要求 |
|---|---|---|
| `GET /healthz` | 服务健康检查与特性状态 | 公开 |
| `POST /api/preflight` | 输入期实时合规预检（零高密泄露） | 有效令牌 |
| `POST /api/ask` | 治理问答与四态判定 | 有效令牌 + RBAC/ABAC |
| `GET /api/datasets/:id/clauses` | 权限裁剪后的条款清单与合规性得分看板数据 | 有效令牌 + RBAC/ABAC |
| `POST /api/datasets/:id/risk-scan` | 一键全库合规边界扫描 | 有效令牌 + RBAC/ABAC |
| `PUT /api/policies/kb/:id` | 更新知识库 RBAC + ABAC 访问策略 | L2 审计权限 |
| `POST /api/feishu/sync/wiki` | 同步飞书知识空间并热加载 | L2 审计权限 |
| `POST /api/feishu/sync/bitable` | 同步飞书多维表格并热加载 | L2 审计权限 |
| `POST /api/feishu/import` | 导入 `[L0]/[L1]/[L2]` 飞书分层 Markdown | L2 审计权限 |
| `POST /api/v1/gateway/govern` | 可插拔治理网关（返回 `safe_context` 与放行标记） | `Bearer` / `X-API-Token` |
| `POST /api/v1/chat/completions` | OpenAI 兼容治理代理（响应头附带 `X-GovLayer-Verdict`） | `Bearer` / `X-API-Token` |
| `GET /api/audit` / `GET /api/audit/export` | 审计流水查询与合规 CSV 导出 | L2 审计权限 |

## 快速启动

### 本地运行（Node.js 22+）

```bash
cp .env.example .env
npm install
npm run build
npm run dev
```

启动后访问 `http://localhost:3000`。

### Docker Compose 部署

```bash
docker compose up -d --build
```

### 网关调用示例（OpenAI 兼容代理）

```bash
curl -X POST "http://localhost:3000/api/v1/chat/completions" \
  -H "Authorization: Bearer demo-l0-employee" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "govlayer:employee_rules",
    "messages": [{"role": "user", "content": "旷工超过多少天会被劝退？"}]
  }'
```

## 内置基准语料

| 标识 | 名称 | 条款数 |
|---|---|---|
| `employee_rules` | 企业员工管理制度 | 7 |
| `registration` | 高校迎新线上报到流程 | 7 |
| `renshi` | 事业单位人事管理条例 | 43 |
| `kaohe` | 事业单位工作人员考核规定 | 50 |

> 权限分层来源会在控制台显式标注；未由真实业务方确认的分层均标示为“提议值”。

## License

MIT
