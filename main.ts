/**
 * KiroGate - Deno Single-File Edition
 *
 * OpenAI & Anthropic 兼容的 Kiro API 网关
 * 基于 KiroGate by dext7r
 *
 * 用法: deno run --allow-net --allow-env --unstable-kv main.ts
 *
 * 欲买桂花同载酒 终不似少年游
 */

// ============================================================================
// 静态资源代理基地址
// ============================================================================
const PROXY_BASE = "https://proxy.jhun.edu.kg";

// ============================================================================
// 类型定义
// ============================================================================

interface Settings {
  proxyApiKey: string;
  refreshToken: string;
  profileArn: string;
  region: string;
  ssoCacheDir: string;
  tokenRefreshThreshold: number;
  maxRetries: number;
  baseRetryDelay: number;
  firstTokenTimeout: number;
  firstTokenMaxRetries: number;
  logLevel: string;
  rateLimitPerMinute: number;
  port: number;
}

interface ChatMessage {
  role: string;
  content: string | ContentBlock[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
  index?: number;
}

interface Tool {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: Tool[];
  tool_choice?: string | Record<string, unknown>;
  stop?: string | string[];
}

interface AnthropicMessage {
  role: string;
  content: string | ContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string | ContentBlock[];
  tools?: AnthropicTool[];
  tool_choice?: Record<string, unknown>;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  thinking?: Record<string, unknown>;
}

interface MetricsData {
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  avgResponseTime: number;
  responseTimes: number[];
  streamRequests: number;
  nonStreamRequests: number;
  modelUsage: Record<string, number>;
  apiTypeUsage: Record<string, number>;  // OpenAI vs Anthropic 统计
  recentRequests: RequestLog[];
  startTime: number;
}

interface RequestLog {
  timestamp: number;
  method: string;
  path: string;
  status: number;
  duration: number;
  model: string;
  error?: string;  // 错误信息，用于排查问题
  apiType?: "openai" | "anthropic";  // API 类型
}

// ============================================================================
// 配置区
// ============================================================================

const MODEL_MAPPING: Record<string, string> = {
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-opus-4-5-20251101": "claude-opus-4.5",
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-haiku-4.5": "claude-haiku-4.5",
  "claude-sonnet-4-5": "CLAUDE_SONNET_4_5_20250929_V1_0",
  "claude-sonnet-4-5-20250929": "CLAUDE_SONNET_4_5_20250929_V1_0",
  "claude-sonnet-4": "CLAUDE_SONNET_4_20250514_V1_0",
  "claude-sonnet-4-20250514": "CLAUDE_SONNET_4_20250514_V1_0",
  "claude-3-7-sonnet-20250219": "CLAUDE_3_7_SONNET_20250219_V1_0",
  "auto": "claude-sonnet-4.5",
};

const AVAILABLE_MODELS = [
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4",
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-20250219",
];

const APP_VERSION = "2.1.2-deno";
const APP_TITLE = "KiroGate";
const APP_DESCRIPTION = "OpenAI & Anthropic 兼容的 Kiro API 代理网关";

// Kiro API 对 tool description 的长度限制（0 表示不限制）
const TOOL_DESCRIPTION_MAX_LENGTH = 4000;

// 从环境变量加载配置
function loadSettings(): Settings {
  return {
    proxyApiKey: Deno.env.get("PROXY_API_KEY") || "changeme_proxy_secret",
    refreshToken: Deno.env.get("REFRESH_TOKEN") || "",
    profileArn: Deno.env.get("PROFILE_ARN") || "",
    region: Deno.env.get("KIRO_REGION") || "us-east-1",
    ssoCacheDir: Deno.env.get("SSO_CACHE_DIR") || "",
    tokenRefreshThreshold: parseInt(Deno.env.get("TOKEN_REFRESH_THRESHOLD") || "600"),
    maxRetries: parseInt(Deno.env.get("MAX_RETRIES") || "3"),
    baseRetryDelay: parseFloat(Deno.env.get("BASE_RETRY_DELAY") || "1.0"),
    firstTokenTimeout: parseFloat(Deno.env.get("FIRST_TOKEN_TIMEOUT") || "15"),
    firstTokenMaxRetries: parseInt(Deno.env.get("FIRST_TOKEN_MAX_RETRIES") || "3"),
    logLevel: Deno.env.get("LOG_LEVEL") || "INFO",
    rateLimitPerMinute: parseInt(Deno.env.get("RATE_LIMIT_PER_MINUTE") || "0"),
    port: parseInt(Deno.env.get("PORT") || "8000"),
  };
}

const settings = loadSettings();

// Kiro API URL 模板
const getKiroRefreshUrl = (region: string) =>
  `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`;
const getKiroApiHost = (region: string) =>
  `https://codewhisperer.${region}.amazonaws.com`;
const getKiroQHost = (region: string) =>
  `https://q.${region}.amazonaws.com`;
const getInternalModelId = (model: string) =>
  MODEL_MAPPING[model] || model;

// ============================================================================
// 日志工具
// ============================================================================

const LogLevel = { TRACE: 0, DEBUG: 1, INFO: 2, WARNING: 3, ERROR: 4 };
const currentLogLevel = LogLevel[settings.logLevel.toUpperCase() as keyof typeof LogLevel] ?? LogLevel.INFO;

const logger = {
  trace: (msg: string) => currentLogLevel <= LogLevel.TRACE && console.log(`[TRACE] ${new Date().toISOString()} ${msg}`),
  debug: (msg: string) => currentLogLevel <= LogLevel.DEBUG && console.log(`[DEBUG] ${new Date().toISOString()} ${msg}`),
  info: (msg: string) => currentLogLevel <= LogLevel.INFO && console.log(`[INFO] ${new Date().toISOString()} ${msg}`),
  warning: (msg: string) => currentLogLevel <= LogLevel.WARNING && console.warn(`[WARN] ${new Date().toISOString()} ${msg}`),
  error: (msg: string) => currentLogLevel <= LogLevel.ERROR && console.error(`[ERROR] ${new Date().toISOString()} ${msg}`),
};

// ============================================================================
// 工具函数
// ============================================================================

function generateUUID(): string {
  return crypto.randomUUID();
}

function generateCompletionId(): string {
  return `chatcmpl-${generateUUID().replace(/-/g, "").slice(0, 24)}`;
}

function generateConversationId(): string {
  return generateUUID();
}

function generateToolCallId(): string {
  return `call_${generateUUID().replace(/-/g, "").slice(0, 8)}`;
}

function generateMessageId(): string {
  return `msg_${generateUUID().replace(/-/g, "").slice(0, 24)}`;
}

function maskToken(token: string): string {
  if (!token || token.length <= 8) {
    return "***";
  }
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

async function getMachineFingerprint(): Promise<string> {
  const hostname = Deno.hostname?.() || "unknown";
  const data = new TextEncoder().encode(`${hostname}-kiro-gateway-deno`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// 简易 Token 计数（约 4 字符 = 1 token）
function countTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ============================================================================
// Deno KV 数据持久化 & 监控数据
// ============================================================================

let kv: Deno.Kv | null = null;

async function getKV(): Promise<Deno.Kv> {
  if (!kv) {
    kv = await Deno.openKv();
  }
  return kv;
}

// 内存中的监控数据（定期批量写入 KV）
const metrics: MetricsData = {
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  avgResponseTime: 0,
  responseTimes: [],
  streamRequests: 0,
  nonStreamRequests: 0,
  modelUsage: {},
  apiTypeUsage: {},
  recentRequests: [],
  startTime: Date.now(),
};

// KV 写入优化：批量写入标志
let metricsNeedsPersist = false;
let lastPersistTime = Date.now();
const PERSIST_INTERVAL = 30000; // 30秒批量写入一次

async function recordRequest(log: RequestLog) {
  metrics.totalRequests++;
  if (log.status >= 200 && log.status < 400) {
    metrics.successRequests++;
  } else {
    metrics.failedRequests++;
  }
  metrics.responseTimes.push(log.duration);
  if (metrics.responseTimes.length > 100) {
    metrics.responseTimes.shift();
  }
  metrics.avgResponseTime = metrics.responseTimes.reduce((a, b) => a + b, 0) / metrics.responseTimes.length;

  if (log.model) {
    metrics.modelUsage[log.model] = (metrics.modelUsage[log.model] || 0) + 1;
  }

  // 统计 API 类型
  if (log.apiType) {
    metrics.apiTypeUsage[log.apiType] = (metrics.apiTypeUsage[log.apiType] || 0) + 1;
  }

  metrics.recentRequests.unshift(log);
  if (metrics.recentRequests.length > 100) {
    metrics.recentRequests.pop();
  }

  // 标记需要持久化，但不立即写入
  metricsNeedsPersist = true;
}

// 定期批量持久化到 KV
async function persistMetricsIfNeeded() {
  const now = Date.now();
  if (metricsNeedsPersist && (now - lastPersistTime) >= PERSIST_INTERVAL) {
    try {
      const db = await getKV();
      await db.set(["metrics", "data"], metrics);
      metricsNeedsPersist = false;
      lastPersistTime = now;
      logger.debug("Metrics persisted to KV");
    } catch (e) {
      logger.warning(`Failed to persist metrics: ${e}`);
    }
  }
}

// 强制立即持久化（用于关闭时）
async function forcePersistMetrics() {
  if (metricsNeedsPersist) {
    try {
      const db = await getKV();
      await db.set(["metrics", "data"], metrics);
      metricsNeedsPersist = false;
      logger.info("Metrics force persisted to KV");
    } catch (e) {
      logger.error(`Failed to force persist metrics: ${e}`);
    }
  }
}

async function loadMetricsFromKV() {
  try {
    const db = await getKV();
    const stored = await db.get<MetricsData>(["metrics", "data"]);
    if (stored.value) {
      Object.assign(metrics, stored.value);
      metrics.startTime = Date.now(); // 重置启动时间
    }
  } catch (e) {
    logger.warning(`Failed to load metrics from KV: ${e}`);
  }
}

// ============================================================================
// 认证管理器
// ============================================================================

class KiroAuthManager {
  private refreshToken: string;
  private profileArn: string;
  private region: string;
  private accessToken: string | null = null;
  private expiresAt: Date | null = null;
  private fingerprint: string = "";
  private refreshUrl: string;
  private _apiHost: string;
  private _qHost: string;

  constructor(
    refreshToken: string,
    profileArn: string = "",
    region: string = "us-east-1",
    ssoCacheDir: string = ""
  ) {
    this.refreshToken = refreshToken;
    this.profileArn = profileArn;
    this.region = region;
    this.refreshUrl = getKiroRefreshUrl(region);
    this._apiHost = getKiroApiHost(region);
    this._qHost = getKiroQHost(region);

    if (!this.refreshToken && ssoCacheDir) {
      this.loadRefreshFromSsoCache(ssoCacheDir);
    }
  }

  async init() {
    this.fingerprint = await getMachineFingerprint();
  }

  get apiHost(): string {
    return this._apiHost;
  }

  get qHost(): string {
    return this._qHost;
  }

  get profile(): string {
    return this.profileArn;
  }

  private async loadRefreshFromSsoCache(cacheDir: string) {
    try {
      const base =
        cacheDir || `${Deno.env.get("HOME") || "/home/appuser"}/.aws/sso/cache`;

      // 优先固定文件名
      const preferred = `${base}/kiro-auth-token.json`;
      const candidates: string[] = [];
      try {
        const stat = await Deno.stat(preferred);
        if (stat.isFile) candidates.push(preferred);
      } catch (_e) {
        // ignore
      }

      for await (const entry of Deno.readDir(base)) {
        if (entry.isFile && entry.name.endsWith(".json")) {
          const p = `${base}/${entry.name}`;
          if (p !== preferred) candidates.push(p);
        }
      }

      for (const p of candidates) {
        try {
          const content = await Deno.readTextFile(p);
          const data = JSON.parse(content) as Record<string, unknown>;
          if (data.refreshToken) {
            this.refreshToken = data.refreshToken as string;
            logger.info(`Loaded refreshToken from ${p}`);
            return;
          }
        } catch (err) {
          logger.debug(`Skip cache file ${p}: ${err}`);
        }
      }
    } catch (e) {
      logger.warning(`Failed to load refreshToken from SSO cache: ${e}`);
    }
  }

  isTokenExpiringSoon(): boolean {
    if (!this.expiresAt) return true;
    const now = Date.now();
    const threshold = now + settings.tokenRefreshThreshold * 1000;
    return this.expiresAt.getTime() <= threshold;
  }

  private async refreshTokenRequest(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error("Refresh token is not set");
    }

    logger.info("Refreshing Kiro token...");

    const payload = { refreshToken: this.refreshToken };
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": `KiroGateway-${this.fingerprint.slice(0, 16)}`,
    };

    let lastError: Error | null = null;
    const maxRetries = 3;
    const baseDelay = 1000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(this.refreshUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errorText = await response.text();

          // 可重试的错误：429, 5xx
          if ([429, 500, 502, 503, 504].includes(response.status)) {
            const delay = baseDelay * Math.pow(2, attempt);
            logger.warning(`Token refresh failed (attempt ${attempt + 1}/${maxRetries}): HTTP ${response.status}, retrying in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }

          // 不可重试的客户端错误 (4xx except 429)
          logger.error(`Token refresh failed with non-retryable error: HTTP ${response.status} - ${errorText}`);
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const data = await response.json();

        if (!data.accessToken) {
          throw new Error(`Response does not contain accessToken: ${JSON.stringify(data)}`);
        }

        this.accessToken = data.accessToken;
        if (data.refreshToken) this.refreshToken = data.refreshToken;
        if (data.profileArn) this.profileArn = data.profileArn;

        const expiresIn = data.expiresIn || 3600;
        this.expiresAt = new Date(Date.now() + (expiresIn - 60) * 1000);

        logger.info(`Token refreshed successfully, expires: ${this.expiresAt.toISOString()}`);
        return;

      } catch (e) {
        lastError = e as Error;

        // 如果是不可重试的错误，直接抛出
        if (e instanceof Error && e.message.includes("HTTP 4")) {
          throw e;
        }

        // 网络错误或超时，继续重试
        if (attempt < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          logger.warning(`Token refresh failed (attempt ${attempt + 1}/${maxRetries}): ${e}, retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    logger.error(`Token refresh failed after ${maxRetries} attempts`);
    throw lastError || new Error("Token refresh failed after all retries");
  }

  async getAccessToken(): Promise<string> {
    if (!this.accessToken || this.isTokenExpiringSoon()) {
      await this.refreshTokenRequest();
    }
    if (!this.accessToken) {
      throw new Error("Failed to obtain access token");
    }
    return this.accessToken;
  }

  async forceRefresh(): Promise<string> {
    await this.refreshTokenRequest();
    return this.accessToken!;
  }

  getHeaders(token: string): Record<string, string> {
    return {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": `aws-sdk-js/1.0.27 ua/2.1 os/deno lang/ts KiroGateway-${this.fingerprint.slice(0, 32)}`,
      "x-amz-user-agent": `aws-sdk-js/1.0.27 KiroGateway-${this.fingerprint.slice(0, 32)}`,
      "x-amzn-codewhisperer-optout": "true",
      "x-amzn-kiro-agent-mode": "vibe",
      "amz-sdk-invocation-id": generateUUID(),
      "amz-sdk-request": "attempt=1; max=3",
    };
  }
}

// ============================================================================
// 格式转换器
// ============================================================================

function extractTextContent(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const item of content) {
      if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>;
        if (obj.type === "text" && typeof obj.text === "string") {
          textParts.push(obj.text);
        } else if (typeof obj.text === "string") {
          textParts.push(obj.text);
        }
      } else if (typeof item === "string") {
        textParts.push(item);
      }
    }
    return textParts.join("");
  }
  return String(content);
}

function mergeAdjacentMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.length) return [];

  const processed: ChatMessage[] = [];
  const pendingToolResults: ContentBlock[] = [];

  for (const msg of messages) {
    if (msg.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: msg.tool_call_id || "",
        content: extractTextContent(msg.content) || "(empty result)",
      });
    } else {
      if (pendingToolResults.length > 0) {
        processed.push({
          role: "user",
          content: [...pendingToolResults],
        });
        pendingToolResults.length = 0;
      }
      processed.push({ ...msg });
    }
  }

  if (pendingToolResults.length > 0) {
    processed.push({
      role: "user",
      content: [...pendingToolResults],
    });
  }

  // 合并相邻同角色消息
  const merged: ChatMessage[] = [];
  for (const msg of processed) {
    if (merged.length === 0) {
      merged.push(msg);
      continue;
    }

    const last = merged[merged.length - 1];
    if (msg.role === last.role) {
      // 合并 content
      if (Array.isArray(last.content) && Array.isArray(msg.content)) {
        // 两者都是数组，直接合并
        last.content = [...last.content, ...msg.content];
      } else if (Array.isArray(last.content)) {
        // last 是数组，msg 是字符
        last.content = [...last.content, { type: "text", text: extractTextContent(msg.content) }];
      } else if (Array.isArray(msg.content)) {
        // last 是字符串，msg 是数组
        last.content = [{ type: "text", text: extractTextContent(last.content) }, ...msg.content];
      } else {
        // 两者都是字符串
        const lastText = extractTextContent(last.content);
        const currentText = extractTextContent(msg.content);
        last.content = `${lastText}\n${currentText}`;
      }

      // 关键修复：合并 assistant 消息的 tool_calls
      // 这是防止 400 错误的核心逻辑
      if (msg.role === "assistant" && msg.tool_calls) {
        if (!last.tool_calls) {
          last.tool_calls = [];
        }
        last.tool_calls = [...last.tool_calls, ...msg.tool_calls];
        logger.debug(`Merged tool_calls: added ${msg.tool_calls.length} tool calls, total now: ${last.tool_calls.length}`);
      }
    } else {
      merged.push(msg);
    }
  }

  return merged;
}

function extractToolResults(content: unknown): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  if (!Array.isArray(content)) return results;

  for (const item of content) {
    if (typeof item === "object" && item !== null) {
      const obj = item as Record<string, unknown>;
      if (obj.type === "tool_result") {
        results.push({
          content: [{ text: extractTextContent(obj.content) }],
          status: "success",
          toolUseId: obj.tool_use_id || "",
        });
      }
    }
  }
  return results;
}

function extractToolUses(msg: ChatMessage): Array<Record<string, unknown>> {
  const toolUses: Array<Record<string, unknown>> = [];

  // 从 tool_calls 字段提取（支持数组和对象两种格式）
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      try {
        // 处理字典类型（兼容不同格式）
        const funcData = typeof tc === "object" && tc !== null
          ? (tc as Record<string, unknown>).function || tc
          : tc;

        let args = "{}";
        let name = "";
        let id = "";

        if (typeof funcData === "object" && funcData !== null) {
          const func = funcData as Record<string, unknown>;
          args = (func.arguments as string) || "{}";
          name = (func.name as string) || "";
        }

        if (typeof tc === "object" && tc !== null) {
          const tcObj = tc as Record<string, unknown>;
          id = (tcObj.id as string) || "";
          if (!name && tcObj.function) {
            const f = tcObj.function as Record<string, unknown>;
            name = (f.name as string) || "";
            args = (f.arguments as string) || "{}";
          }
        }

        const input = typeof args === "string" ? JSON.parse(args) : args;
        toolUses.push({
          name,
          input,
          toolUseId: id,
        });
      } catch (e) {
        logger.warning(`Failed to parse tool call: ${e}`);
        const tc2 = tc as ToolCall;
        toolUses.push({
          name: tc2.function?.name || "",
          input: {},
          toolUseId: tc2.id || "",
        });
      }
    }
  }

  // 从 content 数组中提取 tool_use
  if (Array.isArray(msg.content)) {
    for (const item of msg.content) {
      if (typeof item === "object" && item !== null) {
        const obj = item as ContentBlock;
        if (obj.type === "tool_use") {
          toolUses.push({
            name: obj.name || "",
            input: obj.input || {},
            toolUseId: obj.id || "",
          });
        }
      }
    }
  }

  return toolUses;
}

// 处理超长工具描述：将过长的 description 移到 system prompt
function processToolsWithLongDescriptions(
  tools: Tool[] | undefined
): { processedTools: Tool[] | undefined; toolDocumentation: string } {
  if (!tools || tools.length === 0) {
    return { processedTools: undefined, toolDocumentation: "" };
  }

  // 如果限制禁用，直接返回原始 tools
  if (TOOL_DESCRIPTION_MAX_LENGTH <= 0) {
    return { processedTools: tools, toolDocumentation: "" };
  }

  const toolDocParts: string[] = [];
  const processedTools: Tool[] = [];

  for (const tool of tools) {
    if (tool.type !== "function") {
      processedTools.push(tool);
      continue;
    }

    const description = tool.function.description || "";

    if (description.length <= TOOL_DESCRIPTION_MAX_LENGTH) {
      // 描述长度正常，保持原样
      processedTools.push(tool);
    } else {
      // 描述过长，移到 system prompt
      const toolName = tool.function.name;
      logger.debug(
        `Tool '${toolName}' has long description (${description.length} chars > ${TOOL_DESCRIPTION_MAX_LENGTH}), moving to system prompt`
      );

      toolDocParts.push(`## Tool: ${toolName}\n\n${description}`);

      // 创建带引用描述的新 tool
      const referenceDescription = `[Full documentation in system prompt under '## Tool: ${toolName}']`;
      processedTools.push({
        type: tool.type,
        function: {
          name: tool.function.name,
          description: referenceDescription,
          parameters: tool.function.parameters,
        },
      });
    }
  }

  let toolDocumentation = "";
  if (toolDocParts.length > 0) {
    toolDocumentation =
      "\n\n---\n# Tool Documentation\nThe following tools have detailed documentation that couldn't fit in the tool definition.\n\n" +
      toolDocParts.join("\n\n---\n\n");
  }

  return {
    processedTools: processedTools.length > 0 ? processedTools : undefined,
    toolDocumentation,
  };
}

function buildKiroHistory(messages: ChatMessage[], modelId: string): Array<Record<string, unknown>> {
  const history: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const content = extractTextContent(msg.content);
      const userInput: Record<string, unknown> = {
        content,
        modelId,
        origin: "AI_EDITOR",
      };

      const toolResults = extractToolResults(msg.content);
      if (toolResults.length > 0) {
        userInput.userInputMessageContext = { toolResults };
      }

      history.push({ userInputMessage: userInput });

    } else if (msg.role === "assistant") {
      const content = extractTextContent(msg.content);
      const assistantResponse: Record<string, unknown> = { content };

      const toolUses = extractToolUses(msg);
      if (toolUses.length > 0) {
        assistantResponse.toolUses = toolUses;
      }

      history.push({ assistantResponseMessage: assistantResponse });
    }
  }

  return history;
}

function buildKiroPayload(
  request: ChatCompletionRequest,
  conversationId: string,
  profileArn: string
): Record<string, unknown> {
  const messages = [...request.messages];

  // 处理超长工具描述
  const { processedTools, toolDocumentation } = processToolsWithLongDescriptions(request.tools);

  // 提取 system prompt
  let systemPrompt = "";
  const nonSystemMessages: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt += extractTextContent(msg.content) + "\n";
    } else {
      nonSystemMessages.push(msg);
    }
  }
  systemPrompt = systemPrompt.trim();

  // 将工具文档添加到 system prompt
  if (toolDocumentation) {
    systemPrompt = systemPrompt ? systemPrompt + toolDocumentation : toolDocumentation.trim();
  }

  const merged = mergeAdjacentMessages(nonSystemMessages);
  if (merged.length === 0) {
    throw new Error("No messages to send");
  }

  const modelId = getInternalModelId(request.model);

  // 历史消息（除最后一条）
  const historyMessages = merged.length > 1 ? merged.slice(0, -1) : [];

  // 如果有 system prompt，添加到第一条 user 消息
  if (systemPrompt && historyMessages.length > 0 && historyMessages[0].role === "user") {
    const original = extractTextContent(historyMessages[0].content);
    historyMessages[0].content = `${systemPrompt}\n\n${original}`;
  }

  const history = buildKiroHistory(historyMessages, modelId);

  // 当前消息
  const currentMessage = merged[merged.length - 1];
  let currentContent = extractTextContent(currentMessage.content);

  // 如果没有历史但有 system prompt
  if (systemPrompt && history.length === 0) {
    currentContent = `${systemPrompt}\n\n${currentContent}`;
  }

  // 如果当前是 assistant，需要添加到历史并创建 Continue
  if (currentMessage.role === "assistant") {
    history.push({
      assistantResponseMessage: { content: currentContent },
    });
    currentContent = "Continue";
  }

  if (!currentContent) {
    currentContent = "Continue";
  }

  const userInputMessage: Record<string, unknown> = {
    content: currentContent,
    modelId,
    origin: "AI_EDITOR",
  };

  // 添加 tools（使用处理后的短描述版本）
  if (processedTools && processedTools.length > 0) {
    const toolsList = processedTools.map(tool => ({
      toolSpecification: {
        name: tool.function.name,
        description: tool.function.description || "",
        inputSchema: { json: tool.function.parameters || {} },
      },
    }));
    userInputMessage.userInputMessageContext = { tools: toolsList };
  }

  // 添加 tool_results
  const toolResults = extractToolResults(currentMessage.content);
  if (toolResults.length > 0) {
    const ctx = userInputMessage.userInputMessageContext as Record<string, unknown> || {};
    ctx.toolResults = toolResults;
    userInputMessage.userInputMessageContext = ctx;
  }

  const payload: Record<string, unknown> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId,
      currentMessage: { userInputMessage },
    },
  };

  if (history.length > 0) {
    (payload.conversationState as Record<string, unknown>).history = history;
  }

  if (profileArn) {
    payload.profileArn = profileArn;
  }

  return payload;
}

// Anthropic -> OpenAI 转换
function convertAnthropicToOpenAI(request: AnthropicMessagesRequest): ChatCompletionRequest {
  const openaiMessages: ChatMessage[] = [];

  // 提取 system prompt
  if (request.system) {
    const systemText = typeof request.system === "string"
      ? request.system
      : (request.system as ContentBlock[])
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
    if (systemText) {
      openaiMessages.push({ role: "system", content: systemText });
    }
  }

  // 转换消息
  for (const msg of request.messages) {
    if (typeof msg.content === "string") {
      openaiMessages.push({
        role: msg.role,
        content: msg.content,
      });
    } else {
      const textParts: string[] = [];
      const toolCalls: ToolCall[] = [];
      const toolResults: ContentBlock[] = [];

      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id || "",
            type: "function",
            function: {
              name: block.name || "",
              arguments: JSON.stringify(block.input || {}),
            },
          });
        } else if (block.type === "tool_result") {
          toolResults.push(block);
        } else if (block.type === "thinking") {
          // Anthropic thinking blocks - 保留在文本中
          const thinkingText = (block as Record<string, unknown>).thinking as string || "";
          if (thinkingText) {
            textParts.push(`<thinking>${thinkingText}</thinking>`);
          }
        } else if (block.type === "image") {
          // Image content - 添加占位符
          const source = (block as Record<string, unknown>).source as Record<string, unknown> || {};
          if (source.type === "base64") {
            textParts.push(`[Image: ${source.media_type || "image"}]`);
          } else if (source.type === "url") {
            textParts.push(`[Image URL: ${source.url || ""}]`);
          }
        }
      }

      if (toolResults.length > 0) {
        openaiMessages.push({
          role: "user",
          content: toolResults,
        });
      } else {
        openaiMessages.push({
          role: msg.role,
          content: textParts.join("\n") || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      }
    }
  }

  // 转换 tools
  const tools: Tool[] | undefined = request.tools?.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  return {
    model: request.model,
    messages: openaiMessages,
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    stop: request.stop_sequences,
    tools,
    stream: request.stream,
  };
}

// ============================================================================
// AWS SSE 流解析器
// ============================================================================

// 首 token 超时错误
class FirstTokenTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirstTokenTimeoutError";
  }
}

// 统一的 token 计算函数
interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptSource: string;
  totalSource: string;
}

function calculateUsageTokens(
  fullContent: string,
  contextUsagePercentage: number | null,
  maxInputTokens: number = 200000,
  requestMessages?: ChatMessage[],
  requestTools?: Tool[]
): UsageInfo {
  const completionTokens = countTokens(fullContent);

  let totalTokensFromApi = 0;
  if (contextUsagePercentage !== null && contextUsagePercentage > 0) {
    totalTokensFromApi = Math.floor((contextUsagePercentage / 100) * maxInputTokens);
  }

  let promptTokens: number;
  let totalTokens: number;
  let promptSource: string;
  let totalSource: string;

  if (totalTokensFromApi > 0) {
    promptTokens = Math.max(0, totalTokensFromApi - completionTokens);
    totalTokens = totalTokensFromApi;
    promptSource = "subtraction";
    totalSource = "API Kiro";
  } else {
    // 回退：使用 tiktoken 估算
    promptTokens = 0;
    if (requestMessages) {
      for (const msg of requestMessages) {
        const content = extractTextContent(msg.content);
        promptTokens += countTokens(content);
      }
    }
    if (requestTools) {
      for (const tool of requestTools) {
        promptTokens += countTokens(JSON.stringify(tool));
      }
    }
    totalTokens = promptTokens + completionTokens;
    promptSource = "tiktoken";
    totalSource = "tiktoken";
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    promptSource,
    totalSource,
  };
}

function findMatchingBrace(text: string, startPos: number): number {
  if (startPos >= text.length || text[startPos] !== "{") return -1;

  let braceCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startPos; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === "\\" && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === "{") braceCount++;
      else if (char === "}") {
        braceCount--;
        if (braceCount === 0) return i;
      }
    }
  }

  return -1;
}

class AwsEventStreamParser {
  private buffer = "";
  private lastContent: string | null = null;
  private currentToolCall: ToolCall | null = null;
  private toolCalls: ToolCall[] = [];

  // 事件类型映射
  private static PATTERN_TYPE_MAP: Record<string, string> = {
    '{"content":': "content",
    '{"name":': "tool_start",
    '{"input":': "tool_input",
    '{"stop":': "tool_stop",
    '{"usage":': "usage",
    '{"contextUsagePercentage":': "context_usage",
    '{"followupPrompt":': "followup",
  };

  // 预编译正则表达式（性能优化：单次匹配所有模式）
  private static PATTERN_REGEX = /\{"(?:content|name|input|stop|usage|contextUsagePercentage|followupPrompt)":/g;

  feed(chunk: Uint8Array): Array<{ type: string; data: unknown }> {
    try {
      this.buffer += new TextDecoder().decode(chunk);
    } catch {
      return [];
    }

    const events: Array<{ type: string; data: unknown }> = [];

    while (true) {
      // 使用预编译正则快速定位下一个事件
      AwsEventStreamParser.PATTERN_REGEX.lastIndex = 0;
      const match = AwsEventStreamParser.PATTERN_REGEX.exec(this.buffer);

      if (!match) break;

      const earliestPos = match.index;
      // 从匹配位置提取完整的 pattern 前缀来确定事件类型
      const colonPos = this.buffer.indexOf(":", earliestPos);
      if (colonPos === -1) break;

      const patternPrefix = this.buffer.slice(earliestPos, colonPos + 1);
      const earliestType = AwsEventStreamParser.PATTERN_TYPE_MAP[patternPrefix];

      if (!earliestType) {
        // 未知模式，跳过
        this.buffer = this.buffer.slice(earliestPos + 1);
        continue;
      }

      const jsonEnd = findMatchingBrace(this.buffer, earliestPos);
      if (jsonEnd === -1) break;

      const jsonStr = this.buffer.slice(earliestPos, jsonEnd + 1);
      this.buffer = this.buffer.slice(jsonEnd + 1);

      try {
        const data = JSON.parse(jsonStr);
        const event = this.processEvent(data, earliestType);
        if (event) events.push(event);
      } catch {
        logger.warning(`Failed to parse JSON: ${jsonStr.slice(0, 100)}`);
      }
    }

    return events;
  }

  private processEvent(data: Record<string, unknown>, eventType: string): { type: string; data: unknown } | null {
    switch (eventType) {
      case "content": {
        const content = data.content as string || "";
        if (data.followupPrompt || content === this.lastContent) return null;
        this.lastContent = content;
        return { type: "content", data: content };
      }
      case "tool_start": {
        if (this.currentToolCall) this.finalizeToolCall();

        let inputStr = "";
        const input = data.input;
        if (typeof input === "object" && input !== null) {
          inputStr = JSON.stringify(input);
        } else if (input) {
          inputStr = String(input);
        }

        this.currentToolCall = {
          id: (data.toolUseId as string) || generateToolCallId(),
          type: "function",
          function: {
            name: (data.name as string) || "",
            arguments: inputStr,
          },
        };

        if (data.stop) this.finalizeToolCall();
        return null;
      }
      case "tool_input": {
        if (this.currentToolCall) {
          let inputStr = "";
          const input = data.input;
          if (typeof input === "object" && input !== null) {
            inputStr = JSON.stringify(input);
          } else if (input) {
            inputStr = String(input);
          }
          this.currentToolCall.function.arguments += inputStr;
        }
        return null;
      }
      case "tool_stop": {
        if (this.currentToolCall && data.stop) {
          this.finalizeToolCall();
        }
        return null;
      }
      case "usage":
        return { type: "usage", data: data.usage };
      case "context_usage":
        return { type: "context_usage", data: data.contextUsagePercentage };
      default:
        return null;
    }
  }

  private finalizeToolCall() {
    if (!this.currentToolCall) return;

    let args = this.currentToolCall.function.arguments;
    if (args.trim()) {
      try {
        const parsed = JSON.parse(args);
        this.currentToolCall.function.arguments = JSON.stringify(parsed);
      } catch {
        this.currentToolCall.function.arguments = "{}";
      }
    } else {
      this.currentToolCall.function.arguments = "{}";
    }

    this.toolCalls.push(this.currentToolCall);
    this.currentToolCall = null;
  }

  getToolCalls(): ToolCall[] {
    if (this.currentToolCall) this.finalizeToolCall();

    // 去重
    const seen = new Set<string>();
    const unique: ToolCall[] = [];
    for (const tc of this.toolCalls) {
      const key = `${tc.function.name}-${tc.function.arguments}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(tc);
      }
    }
    return unique;
  }

  reset() {
    this.buffer = "";
    this.lastContent = null;
    this.currentToolCall = null;
    this.toolCalls = [];
  }
}

// ============================================================================
// 流式响应处理
// ============================================================================

// 带超时的读取器包装（用于首 token 超时检测）
async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new FirstTokenTimeoutError(`No response within ${timeoutMs / 1000} seconds`)), timeoutMs);
  });
  return Promise.race([reader.read(), timeoutPromise]);
}

// 内部流式处理函数（支持首 token 超时）
async function* streamKiroToOpenAIInternal(
  response: Response,
  model: string,
  firstTokenTimeoutMs: number = 60000,
  requestMessages?: ChatMessage[],
  requestTools?: Tool[]
): AsyncGenerator<string> {
  const completionId = generateCompletionId();
  const createdTime = Math.floor(Date.now() / 1000);
  let firstChunk = true;
  let firstTokenReceived = false;

  const parser = new AwsEventStreamParser();
  const contentParts: string[] = [];
  let contextUsagePercentage: number | null = null;

  const reader = response.body?.getReader();
  if (!reader) {
    yield "data: [DONE]\n\n";
    return;
  }

  try {
    while (true) {
      // 首次读取时使用超时，后续正常读取
      let readResult: ReadableStreamReadResult<Uint8Array>;
      if (!firstTokenReceived) {
        readResult = await readWithTimeout(reader, firstTokenTimeoutMs);
      } else {
        readResult = await reader.read();
      }

      const { done, value } = readResult;
      if (done) break;

      const events = parser.feed(value);

      for (const event of events) {
        if (event.type === "content") {
          firstTokenReceived = true;  // 标记已收到首 token
          const content = event.data as string;
          contentParts.push(content);

          const delta: Record<string, unknown> = { content };
          if (firstChunk) {
            delta.role = "assistant";
            firstChunk = false;
          }

          const chunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTime,
            model,
            choices: [{ index: 0, delta, finish_reason: null }],
          };

          yield `data: ${JSON.stringify(chunk)}\n\n`;
        } else if (event.type === "context_usage") {
          contextUsagePercentage = event.data as number;
        }
      }
    }

    const fullContent = contentParts.join("");
    const toolCalls = parser.getToolCalls();
    const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";

    // 发送 tool calls
    if (toolCalls.length > 0) {
      const indexedToolCalls = toolCalls.map((tc, idx) => ({
        index: idx,
        id: tc.id,
        type: tc.type,
        function: tc.function,
      }));

      const toolChunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created: createdTime,
        model,
        choices: [{
          index: 0,
          delta: { tool_calls: indexedToolCalls },
          finish_reason: null,
        }],
      };
      yield `data: ${JSON.stringify(toolChunk)}\n\n`;
    }

    // 使用统一的 token 计算函数
    const usageInfo = calculateUsageTokens(
      fullContent,
      contextUsagePercentage,
      200000,
      requestMessages,
      requestTools
    );

    logger.debug(
      `[Usage] ${model}: prompt_tokens=${usageInfo.promptTokens} (${usageInfo.promptSource}), ` +
      `completion_tokens=${usageInfo.completionTokens} (tiktoken), ` +
      `total_tokens=${usageInfo.totalTokens} (${usageInfo.totalSource})`
    );

    const finalChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created: createdTime,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: {
        prompt_tokens: usageInfo.promptTokens,
        completion_tokens: usageInfo.completionTokens,
        total_tokens: usageInfo.totalTokens,
      },
    };

    yield `data: ${JSON.stringify(finalChunk)}\n\n`;
    yield "data: [DONE]\n\n";

  } finally {
    reader.releaseLock();
  }
}

// 带首 token 超时重试的流式处理函数
async function* streamWithFirstTokenRetry(
  makeRequest: () => Promise<Response>,
  model: string,
  maxRetries: number = 3,
  firstTokenTimeoutMs: number = 60000,
  requestMessages?: ChatMessage[],
  requestTools?: Tool[]
): AsyncGenerator<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let response: Response | null = null;
    try {
      if (attempt > 0) {
        logger.warning(`Retry attempt ${attempt + 1}/${maxRetries} after first token timeout`);
      }

      response = await makeRequest();

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`Error from Kiro API: ${response.status} - ${errorText}`);
        throw new Error(`Upstream API error: ${errorText}`);
      }

      // 尝试流式处理，带首 token 超时
      for await (const chunk of streamKiroToOpenAIInternal(
        response,
        model,
        firstTokenTimeoutMs,
        requestMessages,
        requestTools
      )) {
        yield chunk;
      }

      // 成功完成
      return;

    } catch (e) {
      if (e instanceof FirstTokenTimeoutError) {
        lastError = e;
        logger.warning(`First token timeout on attempt ${attempt + 1}/${maxRetries}`);
        // 继续重试
        continue;
      }
      // 其他错误直接抛出
      throw e;
    }
  }

  // 所有重试都失败
  logger.error(`All ${maxRetries} attempts failed due to first token timeout`);
  throw lastError || new Error(`Model did not respond within ${firstTokenTimeoutMs / 1000}s after ${maxRetries} attempts. Please try again.`);
}

// 简单版本（无超时重试）
async function* streamKiroToOpenAI(
  response: Response,
  model: string,
  requestMessages?: ChatMessage[],
  requestTools?: Tool[]
): AsyncGenerator<string> {
  for await (const chunk of streamKiroToOpenAIInternal(response, model, 60000, requestMessages, requestTools)) {
    yield chunk;
  }
}

async function collectStreamResponse(
  response: Response,
  model: string,
  requestMessages?: ChatMessage[],
  requestTools?: Tool[]
): Promise<Record<string, unknown>> {
  const completionId = generateCompletionId();
  const createdTime = Math.floor(Date.now() / 1000);

  const parser = new AwsEventStreamParser();
  const contentParts: string[] = [];
  let contextUsagePercentage: number | null = null;

  const reader = response.body?.getReader();
  if (!reader) {
    return {
      id: completionId,
      object: "chat.completion",
      created: createdTime,
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const events = parser.feed(value);
      for (const event of events) {
        if (event.type === "content") {
          contentParts.push(event.data as string);
        } else if (event.type === "context_usage") {
          contextUsagePercentage = event.data as number;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const fullContent = contentParts.join("");
  const toolCalls = parser.getToolCalls();
  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";

  const message: Record<string, unknown> = {
    role: "assistant",
    content: fullContent,
  };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map(tc => ({
      id: tc.id,
      type: tc.type,
      function: tc.function,
    }));
  }

  // 使用统一的 token 计算函数
  const usageInfo = calculateUsageTokens(
    fullContent,
    contextUsagePercentage,
    200000,
    requestMessages,
    requestTools
  );

  return {
    id: completionId,
    object: "chat.completion",
    created: createdTime,
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: usageInfo.promptTokens,
      completion_tokens: usageInfo.completionTokens,
      total_tokens: usageInfo.totalTokens,
    },
  };
}

// Anthropic 流式响应
async function* streamKiroToAnthropic(
  response: Response,
  model: string,
  requestMessages?: ChatMessage[],
  requestTools?: Tool[]
): AsyncGenerator<string> {
  const messageId = generateMessageId();
  const parser = new AwsEventStreamParser();
  const contentParts: string[] = [];
  let contentBlockIndex = 0;
  let textBlockStarted = false;
  let contextUsagePercentage: number | null = null;

  // message_start
  const messageStart = {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
  yield `event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`;

  const reader = response.body?.getReader();
  if (!reader) {
    yield `event: message_stop\ndata: {"type": "message_stop"}\n\n`;
    return;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const events = parser.feed(value);

      for (const event of events) {
        if (event.type === "content") {
          const content = event.data as string;
          contentParts.push(content);

          if (!textBlockStarted) {
            const blockStart = {
              type: "content_block_start",
              index: contentBlockIndex,
              content_block: { type: "text", text: "" },
            };
            yield `event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`;
            textBlockStarted = true;
          }

          const delta = {
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "text_delta", text: content },
          };
          yield `event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`;
        } else if (event.type === "context_usage") {
          contextUsagePercentage = event.data as number;
        }
      }
    }

    // 关闭 text block
    if (textBlockStarted) {
      yield `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: contentBlockIndex })}\n\n`;
      contentBlockIndex++;
    }

    const fullContent = contentParts.join("");
    const toolCalls = parser.getToolCalls();

    // 发送 tool_use blocks
    for (const tc of toolCalls) {
      const toolId = tc.id || `toolu_${generateCompletionId().slice(8)}`;
      let toolInput = {};
      try {
        toolInput = JSON.parse(tc.function.arguments);
      } catch { /* ignore */ }

      const blockStart = {
        type: "content_block_start",
        index: contentBlockIndex,
        content_block: {
          type: "tool_use",
          id: toolId,
          name: tc.function.name,
          input: {},
        },
      };
      yield `event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`;

      if (Object.keys(toolInput).length > 0) {
        const inputDelta = {
          type: "content_block_delta",
          index: contentBlockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(toolInput),
          },
        };
        yield `event: content_block_delta\ndata: ${JSON.stringify(inputDelta)}\n\n`;
      }

      yield `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: contentBlockIndex })}\n\n`;
      contentBlockIndex++;
    }

    const stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";

    // 使用统一的 token 计算函数
    const usageInfo = calculateUsageTokens(
      fullContent,
      contextUsagePercentage,
      200000,
      requestMessages,
      requestTools
    );

    logger.debug(
      `[Anthropic Usage] ${model}: input_tokens=${usageInfo.promptTokens}, output_tokens=${usageInfo.completionTokens}`
    );

    const messageDelta = {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usageInfo.completionTokens },
    };
    yield `event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`;
    yield `event: message_stop\ndata: {"type": "message_stop"}\n\n`;

  } finally {
    reader.releaseLock();
  }
}

async function collectAnthropicResponse(
  response: Response,
  model: string,
  requestMessages?: ChatMessage[],
  requestTools?: Tool[]
): Promise<Record<string, unknown>> {
  const messageId = generateMessageId();
  const parser = new AwsEventStreamParser();
  const contentParts: string[] = [];
  let contextUsagePercentage: number | null = null;

  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const events = parser.feed(value);
        for (const event of events) {
          if (event.type === "content") {
            contentParts.push(event.data as string);
          } else if (event.type === "context_usage") {
            contextUsagePercentage = event.data as number;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  const fullContent = contentParts.join("");
  const toolCalls = parser.getToolCalls();

  const contentBlocks: Array<Record<string, unknown>> = [];

  if (fullContent) {
    contentBlocks.push({ type: "text", text: fullContent });
  }

  for (const tc of toolCalls) {
    let toolInput = {};
    try {
      toolInput = JSON.parse(tc.function.arguments);
    } catch { /* ignore */ }

    contentBlocks.push({
      type: "tool_use",
      id: tc.id || `toolu_${generateCompletionId().slice(8)}`,
      name: tc.function.name,
      input: toolInput,
    });
  }

  const stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";

  // 使用统一的 token 计算函数
  const usageInfo = calculateUsageTokens(
    fullContent,
    contextUsagePercentage,
    200000,
    requestMessages,
    requestTools
  );

  logger.debug(
    `[Anthropic Usage] ${model}: input_tokens=${usageInfo.promptTokens}, output_tokens=${usageInfo.completionTokens}`
  );

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usageInfo.promptTokens,
      output_tokens: usageInfo.completionTokens,
    },
  };
}

// ============================================================================
// HTTP 请求处理
// ============================================================================

async function requestWithRetry(
  authManager: KiroAuthManager,
  url: string,
  payload: Record<string, unknown>,
  stream: boolean,
): Promise<Response> {
  const maxRetries = stream ? settings.firstTokenMaxRetries : settings.maxRetries;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const token = await authManager.getAccessToken();
      const headers = authManager.getHeaders(token);

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        return response;
      }

      // 400: 客户端错误，记录详细信息后直接返回（不重试）
      // 注意：不在此处消费 body，让调用者处理错误响应
      if (response.status === 400) {
        // 克隆响应以便记录日志，同时保留原始响应供调用者使用
        const clonedResponse = response.clone();
        const errorText = await clonedResponse.text();
        logger.error(`Received 400 Bad Request: ${errorText}`);
        logger.error(`Request payload: ${JSON.stringify(payload, null, 2)}`);
        return response;
      }

      // 403: Token 过期，刷新后重试
      if (response.status === 403) {
        logger.warning(`Received 403, refreshing token (attempt ${attempt + 1}/${maxRetries})`);
        await authManager.forceRefresh();
        continue;
      }

      // 429: 速率限制，指数退避重试
      if (response.status === 429) {
        const delay = settings.baseRetryDelay * Math.pow(2, attempt) * 1000;
        logger.warning(`Received 429 Rate Limited, waiting ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // 5xx: 服务器错误，指数退避重试
      if (response.status >= 500 && response.status < 600) {
        const delay = settings.baseRetryDelay * Math.pow(2, attempt) * 1000;
        logger.warning(`Received ${response.status} Server Error, waiting ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // 其他错误直接返回
      return response;

    } catch (e) {
      lastError = e as Error;
      const delay = settings.baseRetryDelay * Math.pow(2, attempt) * 1000;
      logger.warning(`Request error: ${e}, waiting ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastError || new Error(`Failed after ${maxRetries} attempts`);
}

// ============================================================================
// 前端页面 HTML 生成
// ============================================================================

const COMMON_HEAD = `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KiroGate - OpenAI & Anthropic 兼容的 Kiro API 代理网关</title>

  <!-- SEO Meta Tags -->
  <meta name="description" content="KiroGate 是一个开源的 Kiro IDE API 代理网关，支持 OpenAI 和 Anthropic API 格式，让你可以通过任何兼容的工具使用 Claude 模型。支持流式传输、工具调用、多租户等特性。">
  <meta name="keywords" content="KiroGate, Kiro, Claude, OpenAI, Anthropic, API Gateway, Proxy, AI, LLM, Claude Code, Deno, 代理网关">
  <meta name="author" content="KiroGate">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="https://kirogate.deno.dev/">

  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://kirogate.deno.dev/">
  <meta property="og:title" content="KiroGate - OpenAI & Anthropic 兼容的 Kiro API 代理网关">
  <meta property="og:description" content="开源的 Kiro IDE API 代理网关，支持 OpenAI 和 Anthropic API 格式，通过任何兼容工具使用 Claude 模型。">
  <meta property="og:site_name" content="KiroGate">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:url" content="https://kirogate.deno.dev/">
  <meta name="twitter:title" content="KiroGate - OpenAI & Anthropic 兼容的 Kiro API 代理网关">
  <meta name="twitter:description" content="开源的 Kiro IDE API 代理网关，支持 OpenAI 和 Anthropic API 格式，通过任何兼容工具使用 Claude 模型。">

  <!-- Favicon -->
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚀</text></svg>">

  <script src="${PROXY_BASE}/proxy/cdn.tailwindcss.com"></script>
  <script src="${PROXY_BASE}/proxy/cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
  <script src="${PROXY_BASE}/proxy/cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --primary: #6366f1;
      --primary-dark: #4f46e5;
    }

    /* Light mode (default) */
    [data-theme="light"] {
      --bg-main: #ffffff;
      --bg-card: #f8fafc;
      --bg-nav: #ffffff;
      --bg-input: #ffffff;
      --text: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --border-dark: #cbd5e1;
    }

    /* Dark mode */
    [data-theme="dark"] {
      --bg-main: #0f172a;
      --bg-card: #1e293b;
      --bg-nav: #1e293b;
      --bg-input: #334155;
      --text: #e2e8f0;
      --text-muted: #94a3b8;
      --border: #334155;
      --border-dark: #475569;
    }

    body {
      background: var(--bg-main);
      color: var(--text);
      font-family: system-ui, -apple-system, sans-serif;
      transition: background-color 0.3s, color 0.3s;
    }
    .card {
      background: var(--bg-card);
      border-radius: 0.75rem;
      padding: 1.5rem;
      border: 1px solid var(--border);
      transition: background-color 0.3s, border-color 0.3s;
    }
    .btn-primary {
      background: var(--primary);
      color: white;
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
      transition: all 0.2s;
    }
    .btn-primary:hover { background: var(--primary-dark); }
    .nav-link {
      color: var(--text-muted);
      transition: color 0.2s;
    }
    .nav-link:hover, .nav-link.active { color: var(--primary); }
    .theme-toggle {
      cursor: pointer;
      padding: 0.5rem;
      border-radius: 0.5rem;
      transition: background-color 0.2s;
    }
    .theme-toggle:hover {
      background: var(--bg-card);
    }
    /* 代码块优化 */
    pre {
      max-width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    pre::-webkit-scrollbar {
      height: 6px;
    }
    pre::-webkit-scrollbar-track {
      background: var(--bg-input);
      border-radius: 3px;
    }
    pre::-webkit-scrollbar-thumb {
      background: var(--border-dark);
      border-radius: 3px;
    }
    /* 加载动画 */
    .loading-spinner {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid var(--border);
      border-radius: 50%;
      border-top-color: var(--primary);
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .loading-pulse {
      animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    /* 表格响应式 */
    .table-responsive {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .table-responsive::-webkit-scrollbar {
      height: 6px;
    }
    .table-responsive::-webkit-scrollbar-track {
      background: var(--bg-input);
    }
    .table-responsive::-webkit-scrollbar-thumb {
      background: var(--border-dark);
      border-radius: 3px;
    }
  </style>
  <script>
    // Theme initialization
    (function() {
      const theme = localStorage.getItem('theme') || 'light';
      document.documentElement.setAttribute('data-theme', theme);
    })();
  </script>
`;

const COMMON_NAV = `
  <nav style="background: var(--bg-nav); border-bottom: 1px solid var(--border);" class="sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex justify-between h-16">
        <div class="flex items-center space-x-8">
          <a href="/" class="text-2xl font-bold text-indigo-500">⚡ KiroGate</a>
          <div class="hidden md:flex space-x-6">
            <a href="/" class="nav-link">首页</a>
            <a href="/docs" class="nav-link">文档</a>
            <a href="/swagger" class="nav-link">Swagger</a>
            <a href="/playground" class="nav-link">Playground</a>
            <a href="/deploy" class="nav-link">部署</a>
            <a href="/dashboard" class="nav-link">Dashboard</a>
          </div>
        </div>
        <div class="flex items-center space-x-4">
          <button onclick="toggleTheme()" class="theme-toggle" title="切换主题">
            <svg id="theme-icon-sun" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="display: none;">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/>
            </svg>
            <svg id="theme-icon-moon" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="display: none;">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>
            </svg>
          </button>
          <span class="hidden sm:inline text-sm" style="color: var(--text-muted);">v${APP_VERSION}</span>
          <!-- 移动端汉堡菜单按钮 -->
          <button onclick="toggleMobileMenu()" class="md:hidden theme-toggle" title="菜单">
            <svg id="menu-icon-open" class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
            </svg>
            <svg id="menu-icon-close" class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="display: none;">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
    <!-- 移动端导航菜单 -->
    <div id="mobile-menu" class="md:hidden hidden" style="background: var(--bg-nav); border-top: 1px solid var(--border);">
      <div class="px-4 py-3 space-y-2">
        <a href="/" class="block nav-link py-2 px-3 rounded hover:bg-indigo-500/10">首页</a>
        <a href="/docs" class="block nav-link py-2 px-3 rounded hover:bg-indigo-500/10">文档</a>
        <a href="/swagger" class="block nav-link py-2 px-3 rounded hover:bg-indigo-500/10">Swagger</a>
        <a href="/playground" class="block nav-link py-2 px-3 rounded hover:bg-indigo-500/10">Playground</a>
        <a href="/deploy" class="block nav-link py-2 px-3 rounded hover:bg-indigo-500/10">部署</a>
        <a href="/dashboard" class="block nav-link py-2 px-3 rounded hover:bg-indigo-500/10">Dashboard</a>
      </div>
    </div>
  </nav>
  <script>
    function toggleTheme() {
      const html = document.documentElement;
      const currentTheme = html.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
      updateThemeIcon();
    }

    function updateThemeIcon() {
      const theme = document.documentElement.getAttribute('data-theme');
      const sunIcon = document.getElementById('theme-icon-sun');
      const moonIcon = document.getElementById('theme-icon-moon');
      if (theme === 'dark') {
        sunIcon.style.display = 'block';
        moonIcon.style.display = 'none';
      } else {
        sunIcon.style.display = 'none';
        moonIcon.style.display = 'block';
      }
    }

    function toggleMobileMenu() {
      const menu = document.getElementById('mobile-menu');
      const openIcon = document.getElementById('menu-icon-open');
      const closeIcon = document.getElementById('menu-icon-close');
      const isHidden = menu.classList.contains('hidden');

      if (isHidden) {
        menu.classList.remove('hidden');
        openIcon.style.display = 'none';
        closeIcon.style.display = 'block';
      } else {
        menu.classList.add('hidden');
        openIcon.style.display = 'block';
        closeIcon.style.display = 'none';
      }
    }

    // Initialize icon on page load
    document.addEventListener('DOMContentLoaded', updateThemeIcon);
  </script>
`;

const COMMON_FOOTER = `
  <footer style="background: var(--bg-nav); border-top: 1px solid var(--border);" class="py-6 sm:py-8 mt-12 sm:mt-16">
    <div class="max-w-7xl mx-auto px-4 text-center" style="color: var(--text-muted);">
      <p class="text-sm sm:text-base">KiroGate - OpenAI & Anthropic 兼容的 Kiro API 网关</p>
      <div class="mt-3 sm:mt-4 flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs sm:text-sm">
        <span class="flex items-center gap-1">
          <span style="color: var(--text);">Deno</span>
          <a href="https://kirogate.deno.dev" class="text-indigo-400 hover:underline" target="_blank">Demo</a>
          <span>·</span>
          <a href="https://github.com/dext7r/KiroGate" class="text-indigo-400 hover:underline" target="_blank">GitHub</a>
        </span>
        <span class="hidden sm:inline" style="color: var(--border-dark);">|</span>
        <span class="flex items-center gap-1">
          <span style="color: var(--text);">Python</span>
          <a href="https://kirogate.fly.dev" class="text-indigo-400 hover:underline" target="_blank">Demo</a>
          <span>·</span>
          <a href="https://github.com/aliom-v/KiroGate" class="text-indigo-400 hover:underline" target="_blank">GitHub</a>
        </span>
      </div>
      <p class="mt-3 text-xs sm:text-sm opacity-75">欲买桂花同载酒 终不似少年游</p>
    </div>
  </footer>
`;

function renderHomePage(): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>${COMMON_HEAD}</head>
<body>
  ${COMMON_NAV}

  <main class="max-w-7xl mx-auto px-4 py-8 sm:py-12">
    <!-- Hero Section -->
    <section class="text-center py-8 sm:py-16">
      <h1 class="text-3xl sm:text-4xl md:text-5xl font-bold mb-4 sm:mb-6 bg-gradient-to-r from-indigo-400 to-purple-500 bg-clip-text text-transparent">
        KiroGate API 网关
      </h1>
      <p class="text-base sm:text-xl text-slate-400 mb-6 sm:mb-8 max-w-2xl mx-auto px-4">
        将 OpenAI 和 Anthropic API 请求无缝代理到 Kiro (AWS CodeWhisperer)，
        支持完整的流式传输、工具调用和多模型切换。
      </p>
      <div class="flex flex-col sm:flex-row justify-center gap-3 sm:gap-4 px-4">
        <a href="/docs" class="btn-primary text-base sm:text-lg px-6 py-3">📖 查看文档</a>
        <a href="/playground" class="btn-primary text-base sm:text-lg px-6 py-3 bg-slate-700 hover:bg-slate-600">🎮 在线试用</a>
      </div>
    </section>

    <!-- Features Grid -->
    <section class="grid md:grid-cols-3 gap-6 py-12">
      <div class="card">
        <div class="text-3xl mb-4">🔄</div>
        <h3 class="text-xl font-semibold mb-2">双 API 兼容</h3>
        <p class="text-slate-400">同时支持 OpenAI 和 Anthropic API 格式，无需修改现有代码。</p>
      </div>
      <div class="card">
        <div class="text-3xl mb-4">⚡</div>
        <h3 class="text-xl font-semibold mb-2">流式传输</h3>
        <p class="text-slate-400">完整的 SSE 流式支持，实时获取模型响应。</p>
      </div>
      <div class="card">
        <div class="text-3xl mb-4">🔧</div>
        <h3 class="text-xl font-semibold mb-2">工具调用</h3>
        <p class="text-slate-400">支持 Function Calling，构建强大的 AI Agent。</p>
      </div>
      <div class="card">
        <div class="text-3xl mb-4">🔁</div>
        <h3 class="text-xl font-semibold mb-2">自动重试</h3>
        <p class="text-slate-400">智能处理 403/429/5xx 错误，自动刷新 Token。</p>
      </div>
      <div class="card">
        <div class="text-3xl mb-4">📊</div>
        <h3 class="text-xl font-semibold mb-2">监控面板</h3>
        <p class="text-slate-400">实时查看请求统计、响应时间和模型使用情况。</p>
      </div>
      <div class="card">
        <div class="text-3xl mb-4">🦕</div>
        <h3 class="text-xl font-semibold mb-2">Deno 原生</h3>
        <p class="text-slate-400">单文件部署，零配置启动，内置 KV 存储。</p>
      </div>
    </section>

    <!-- Stats Chart -->
    <section class="py-12">
      <h2 class="text-2xl font-bold mb-6 text-center">📈 支持的模型</h2>
      <div class="card">
        <div id="modelsChart" style="height: 300px;"></div>
      </div>
    </section>
  </main>

  ${COMMON_FOOTER}

  <script>
    // ECharts 模型展示图
    const modelsChart = echarts.init(document.getElementById('modelsChart'));
    modelsChart.setOption({
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: ${JSON.stringify(AVAILABLE_MODELS)},
        axisLabel: { rotate: 45, color: '#94a3b8' },
        axisLine: { lineStyle: { color: '#334155' } }
      },
      yAxis: {
        type: 'value',
        name: '性能指数',
        axisLabel: { color: '#94a3b8' },
        axisLine: { lineStyle: { color: '#334155' } },
        splitLine: { lineStyle: { color: '#1e293b' } }
      },
      series: [{
        name: '模型能力',
        type: 'bar',
        data: [100, 100, 70, 90, 90, 85, 85, 80],
        itemStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: '#6366f1' },
            { offset: 1, color: '#4f46e5' }
          ])
        }
      }]
    });
    window.addEventListener('resize', () => modelsChart.resize());
  </script>
</body>
</html>`;
}

function renderDocsPage(): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>${COMMON_HEAD}</head>
<body>
  ${COMMON_NAV}

  <main class="max-w-7xl mx-auto px-4 py-12">
    <h1 class="text-4xl font-bold mb-8">📖 API 文档</h1>

    <div class="space-y-8">
      <section class="card">
        <h2 class="text-2xl font-semibold mb-4">🔑 认证</h2>
        <p style="color: var(--text-muted);" class="mb-4">所有 API 请求需要在 Header 中携带 API Key。支持两种认证模式：</p>

        <h3 class="text-lg font-medium mb-2 text-indigo-400">模式 1: 简单模式（使用服务器配置的 REFRESH_TOKEN）</h3>
        <pre style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="p-4 rounded-lg overflow-x-auto text-sm mb-4">
# OpenAI 格式
Authorization: Bearer YOUR_PROXY_API_KEY

# Anthropic 格式
x-api-key: YOUR_PROXY_API_KEY</pre>

        <h3 class="text-lg font-medium mb-2 text-indigo-400">模式 2: 组合模式（用户自带 REFRESH_TOKEN，无需服务器配置）✨ 推荐</h3>
        <pre style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="p-4 rounded-lg overflow-x-auto text-sm">
# OpenAI 格式
Authorization: Bearer YOUR_PROXY_API_KEY:YOUR_REFRESH_TOKEN

# Anthropic 格式
x-api-key: YOUR_PROXY_API_KEY:YOUR_REFRESH_TOKEN</pre>

        <div style="background: var(--bg-input); border: 1px solid var(--border);" class="p-4 rounded-lg mt-4">
          <p class="text-sm" style="color: var(--text-muted);">
            <strong>💡 优先级说明：</strong>
          </p>
          <ul class="text-sm mt-2 space-y-1" style="color: var(--text-muted);">
            <li>• <strong>优先使用组合模式</strong>：如果 API Key 包含冒号 <code>:</code>，自动识别为 <code>PROXY_API_KEY:REFRESH_TOKEN</code> 格式</li>
            <li>• <strong>回退到简单模式</strong>：如果不包含冒号，使用服务器配置的全局 REFRESH_TOKEN</li>
            <li>• <strong>多租户支持</strong>：组合模式允许多个用户使用各自的 REFRESH_TOKEN，无需修改服务器配置</li>
            <li>• <strong>缓存优化</strong>：每个用户的认证信息会被缓存（最多100个用户），提升性能</li>
          </ul>
        </div>
      </section>

      <section class="card">
        <h2 class="text-2xl font-semibold mb-4">📡 端点列表</h2>
        <div class="space-y-4">
          <div style="background: var(--bg-input); border: 1px solid var(--border);" class="p-4 rounded-lg">
            <div class="flex items-center gap-2 mb-2">
              <span class="bg-green-600 text-white text-xs px-2 py-1 rounded">GET</span>
              <code class="text-indigo-400">/</code>
            </div>
            <p style="color: var(--text-muted);" class="text-sm">健康检查</p>
          </div>
          <div style="background: var(--bg-input); border: 1px solid var(--border);" class="p-4 rounded-lg">
            <div class="flex items-center gap-2 mb-2">
              <span class="bg-green-600 text-white text-xs px-2 py-1 rounded">GET</span>
              <code class="text-indigo-400">/v1/models</code>
            </div>
            <p style="color: var(--text-muted);" class="text-sm">获取可用模型列表</p>
          </div>
          <div style="background: var(--bg-input); border: 1px solid var(--border);" class="p-4 rounded-lg">
            <div class="flex items-center gap-2 mb-2">
              <span class="bg-blue-600 text-white text-xs px-2 py-1 rounded">POST</span>
              <code class="text-indigo-400">/v1/chat/completions</code>
            </div>
            <p style="color: var(--text-muted);" class="text-sm">OpenAI 兼容的聊天补全 API</p>
          </div>
          <div style="background: var(--bg-input); border: 1px solid var(--border);" class="p-4 rounded-lg">
            <div class="flex items-center gap-2 mb-2">
              <span class="bg-blue-600 text-white text-xs px-2 py-1 rounded">POST</span>
              <code class="text-indigo-400">/v1/messages</code>
            </div>
            <p style="color: var(--text-muted);" class="text-sm">Anthropic 兼容的 Messages API</p>
          </div>
        </div>
      </section>

      <section class="card">
        <h2 class="text-2xl font-semibold mb-4">💡 使用示例</h2>
        <h3 class="text-lg font-medium mb-2 text-indigo-400">OpenAI SDK (Python)</h3>
        <pre style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="p-4 rounded-lg overflow-x-auto text-sm mb-4">
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8000/v1",
    api_key="YOUR_PROXY_API_KEY"
)

response = client.chat.completions.create(
    model="claude-sonnet-4-5",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content, end="")</pre>

        <h3 class="text-lg font-medium mb-2 text-indigo-400">Anthropic SDK (Python)</h3>
        <pre style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="p-4 rounded-lg overflow-x-auto text-sm mb-4">
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:8000",
    api_key="YOUR_PROXY_API_KEY"
)

message = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)

print(message.content[0].text)</pre>

        <h3 class="text-lg font-medium mb-2 text-indigo-400">cURL</h3>
        <pre style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="p-4 rounded-lg overflow-x-auto text-sm">
curl http://localhost:8000/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'</pre>
      </section>

      <section class="card">
        <h2 class="text-2xl font-semibold mb-4">🤖 可用模型</h2>
        <ul class="grid md:grid-cols-2 gap-2">
          ${AVAILABLE_MODELS.map(m => `<li style="background: var(--bg-input); border: 1px solid var(--border);" class="px-4 py-2 rounded text-sm"><code>${m}</code></li>`).join("")}
        </ul>
      </section>
    </div>
  </main>

  ${COMMON_FOOTER}
</body>
</html>`;
}

function renderPlaygroundPage(): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>${COMMON_HEAD}</head>
<body>
  ${COMMON_NAV}

  <main class="max-w-7xl mx-auto px-4 py-12">
    <h1 class="text-4xl font-bold mb-8">🎮 API Playground</h1>

    <div class="grid md:grid-cols-2 gap-6">
      <!-- Request Panel -->
      <div class="card">
        <h2 class="text-xl font-semibold mb-4">请求配置</h2>

        <div class="space-y-4">
          <div>
            <label class="block text-sm mb-1" style="color: var(--text-muted);">API Key</label>
            <input type="password" id="apiKey" style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="w-full rounded px-3 py-2" placeholder="PROXY_API_KEY 或 PROXY_API_KEY:REFRESH_TOKEN" oninput="updateAuthMode()">
            <div id="authModeDisplay" class="mt-2 text-sm flex items-center gap-2">
              <span id="authModeIcon">🔒</span>
              <span id="authModeText" style="color: var(--text-muted);">输入 API Key 后显示认证模式</span>
            </div>
          </div>

          <div>
            <label class="block text-sm mb-1" style="color: var(--text-muted);">模型</label>
            <select id="model" style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="w-full rounded px-3 py-2">
              ${AVAILABLE_MODELS.map(m => `<option value="${m}">${m}</option>`).join("")}
            </select>
          </div>

          <div>
            <label class="block text-sm mb-1" style="color: var(--text-muted);">消息内容</label>
            <textarea id="message" rows="4" style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="w-full rounded px-3 py-2" placeholder="输入你的消息...">Hello! Please introduce yourself briefly.</textarea>
          </div>

          <div class="flex items-center gap-4">
            <label class="flex items-center gap-2">
              <input type="checkbox" id="stream" checked class="rounded">
              <span class="text-sm">流式响应</span>
            </label>
            <label class="flex items-center gap-2">
              <input type="radio" name="apiFormat" value="openai" checked>
              <span class="text-sm">OpenAI 格式</span>
            </label>
            <label class="flex items-center gap-2">
              <input type="radio" name="apiFormat" value="anthropic">
              <span class="text-sm">Anthropic 格式</span>
            </label>
          </div>

          <button id="sendBtn" onclick="sendRequest()" class="btn-primary w-full py-3 text-base sm:text-lg">
            <span id="sendBtnText">🚀 发送请求</span>
            <span id="sendBtnLoading" class="hidden"><span class="loading-spinner mr-2"></span>请求中...</span>
          </button>
        </div>
      </div>

      <!-- Response Panel -->
      <div class="card">
        <h2 class="text-lg sm:text-xl font-semibold mb-4">响应结果</h2>
        <div id="response" style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="rounded p-3 sm:p-4 min-h-[250px] sm:min-h-[300px] whitespace-pre-wrap text-xs sm:text-sm font-mono overflow-auto">
          <span style="color: var(--text-muted);">响应将显示在这里...</span>
        </div>
        <div id="stats" class="mt-3 sm:mt-4 text-xs sm:text-sm" style="color: var(--text-muted);"></div>
      </div>
    </div>
  </main>

  ${COMMON_FOOTER}

  <script>
    function updateAuthMode() {
      const apiKey = document.getElementById('apiKey').value;
      const iconEl = document.getElementById('authModeIcon');
      const textEl = document.getElementById('authModeText');

      if (!apiKey) {
        iconEl.textContent = '🔒';
        textEl.textContent = '输入 API Key 后显示认证模式';
        textEl.style.color = 'var(--text-muted)';
        return;
      }

      if (apiKey.includes(':')) {
        // 组合模式
        iconEl.textContent = '👥';
        textEl.innerHTML = '<span style="color: #22c55e; font-weight: 600;">组合模式</span> <span style="color: var(--text-muted);">- PROXY_API_KEY:REFRESH_TOKEN（多租户）</span>';
      } else {
        // 简单模式
        iconEl.textContent = '🔑';
        textEl.innerHTML = '<span style="color: #3b82f6; font-weight: 600;">简单模式</span> <span style="color: var(--text-muted);">- 使用服务器配置的 REFRESH_TOKEN</span>';
      }
    }

    async function sendRequest() {
      const apiKey = document.getElementById('apiKey').value;
      const model = document.getElementById('model').value;
      const message = document.getElementById('message').value;
      const stream = document.getElementById('stream').checked;
      const format = document.querySelector('input[name="apiFormat"]:checked').value;

      const responseEl = document.getElementById('response');
      const statsEl = document.getElementById('stats');
      const sendBtn = document.getElementById('sendBtn');
      const sendBtnText = document.getElementById('sendBtnText');
      const sendBtnLoading = document.getElementById('sendBtnLoading');

      // 显示加载状态
      sendBtn.disabled = true;
      sendBtnText.classList.add('hidden');
      sendBtnLoading.classList.remove('hidden');
      responseEl.innerHTML = '<span class="loading-pulse" style="color: var(--text-muted);">请求中...</span>';
      statsEl.textContent = '';

      const startTime = Date.now();

      try {
        const endpoint = format === 'openai' ? '/v1/chat/completions' : '/v1/messages';
        const headers = {
          'Content-Type': 'application/json',
        };

        if (format === 'openai') {
          headers['Authorization'] = 'Bearer ' + apiKey;
        } else {
          headers['x-api-key'] = apiKey;
        }

        const body = format === 'openai' ? {
          model,
          messages: [{ role: 'user', content: message }],
          stream
        } : {
          model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: message }],
          stream
        };

        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(error);
        }

        if (stream) {
          responseEl.textContent = '';
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let fullContent = '';
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\\n');

            // Keep the last incomplete line in buffer
            buffer = lines.pop() || '';

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();

              if (format === 'openai') {
                if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                  try {
                    const data = JSON.parse(line.slice(6));
                    const content = data.choices?.[0]?.delta?.content || '';
                    fullContent += content;
                  } catch {}
                }
              } else if (format === 'anthropic') {
                // Anthropic SSE format: event line followed by data line
                if (line.startsWith('event: content_block_delta')) {
                  // Next line should be the data
                  const nextLine = lines[i + 1];
                  if (nextLine && nextLine.trim().startsWith('data: ')) {
                    try {
                      const data = JSON.parse(nextLine.trim().slice(6));
                      if (data.delta?.text) {
                        fullContent += data.delta.text;
                      }
                    } catch {}
                  }
                }
              }
            }
            responseEl.textContent = fullContent;
          }
        } else {
          const data = await response.json();
          if (format === 'openai') {
            responseEl.textContent = data.choices?.[0]?.message?.content || JSON.stringify(data, null, 2);
          } else {
            const text = data.content?.find(c => c.type === 'text')?.text || JSON.stringify(data, null, 2);
            responseEl.textContent = text;
          }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        statsEl.textContent = '耗时: ' + duration + 's';

      } catch (e) {
        responseEl.textContent = '错误: ' + e.message;
      } finally {
        // 恢复按钮状态
        sendBtn.disabled = false;
        sendBtnText.classList.remove('hidden');
        sendBtnLoading.classList.add('hidden');
      }
    }
  </script>
</body>
</html>`;
}

function renderDeployPage(): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>${COMMON_HEAD}</head>
<body>
  ${COMMON_NAV}

  <main class="max-w-7xl mx-auto px-4 py-12">
    <h1 class="text-4xl font-bold mb-8">🚀 部署指南</h1>

    <div class="space-y-8">
      <section class="card">
        <h2 class="text-2xl font-semibold mb-4">📋 环境要求</h2>
        <ul class="list-disc list-inside space-y-2" style="color: var(--text-muted);">
          <li>Deno 1.40+ (推荐最新版)</li>
          <li>Kiro IDE 账号及有效的 Refresh Token</li>
          <li>网络连接（需访问 AWS CodeWhisperer API）</li>
        </ul>
      </section>

      <section class="card">
        <h2 class="text-2xl font-semibold mb-4">⚙️ 环境变量配置</h2>
        <pre style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="p-4 rounded-lg overflow-x-auto text-sm">
# 必填项
PROXY_API_KEY="your-secret-api-key"      # 代理服务器密码

# 可选项（仅简单模式需要）
# 如果使用组合模式（PROXY_API_KEY:REFRESH_TOKEN），可以不配置此项
REFRESH_TOKEN="your-kiro-refresh-token"  # Kiro Refresh Token

# 其他可选配置
KIRO_REGION="us-east-1"                  # AWS 区域
PROFILE_ARN="arn:aws:..."                # Profile ARN (通常自动获取)
PORT="8000"                               # 服务端口
LOG_LEVEL="INFO"                          # 日志级别

# 或使用 SSO 缓存目录（默认 ~/.aws/sso/cache）
SSO_CACHE_DIR="~/.aws/sso/cache"</pre>

        <div style="background: var(--bg-input); border: 1px solid var(--border);" class="p-4 rounded-lg mt-4">
          <p class="text-sm font-semibold mb-2" style="color: var(--text);">配置说明：</p>
          <ul class="text-sm space-y-1" style="color: var(--text-muted);">
            <li>• <strong>简单模式</strong>：必须配置 <code>REFRESH_TOKEN</code> 环境变量</li>
            <li>• <strong>组合模式（推荐）</strong>：无需配置 <code>REFRESH_TOKEN</code>，用户在请求中直接传递</li>
            <li>• <strong>多租户部署</strong>：使用组合模式可以让多个用户共享同一网关实例</li>
          </ul>
        </div>
      </section>

      <section class="card">
        <h2 class="text-2xl font-semibold mb-4">🦕 Deno 本地运行</h2>
        <pre style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="p-4 rounded-lg overflow-x-auto text-sm">
# 简单模式：设置环境变量
export PROXY_API_KEY="your-secret-key"
export REFRESH_TOKEN="your-refresh-token"

# 组合模式（推荐）：只需设置 PROXY_API_KEY
export PROXY_API_KEY="your-secret-key"
# 用户在请求中传递 PROXY_API_KEY:REFRESH_TOKEN

# 运行服务
deno run --allow-net --allow-env --unstable-kv main.ts

# 或指定权限
deno run \\
  --allow-net \\
  --allow-env \\
  --allow-read \\
  --unstable-kv \\
  main.ts</pre>
      </section>

      <section class="card">
        <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
          <span>🐳</span>
          <span>Docker 部署</span>
        </h2>
        <h3 class="text-lg font-medium mb-2 text-indigo-400">简单模式</h3>
        <pre style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="p-4 rounded-lg overflow-x-auto text-sm">
# Dockerfile
FROM denoland/deno:latest

WORKDIR /app
COPY main.ts .

EXPOSE 8000

CMD ["run", "--allow-net", "--allow-env", "--unstable-kv", "main.ts"]</pre>
        <pre style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="p-4 rounded-lg overflow-x-auto text-sm mt-4">
# 构建并运行
docker build -t kirogate .
docker run -d \\
  -p 8000:8000 \\
  -e PROXY_API_KEY="your-key" \\
  -e REFRESH_TOKEN="your-token" \\
  kirogate</pre>

        <h3 class="text-lg font-medium mb-2 mt-6 text-indigo-400">组合模式（推荐 - 无需配置 REFRESH_TOKEN）</h3>
        <pre style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="p-4 rounded-lg overflow-x-auto text-sm">
# 构建并运行（只需配置 PROXY_API_KEY）
docker build -t kirogate .
docker run -d \\
  -p 8000:8000 \\
  -e PROXY_API_KEY="your-key" \\
  kirogate

# 用户在请求中传递 PROXY_API_KEY:REFRESH_TOKEN</pre>
      </section>

      <section class="card">
        <h2 class="text-2xl font-semibold mb-4 flex items-center gap-2">
          <span>☁️</span>
          <span>Deno Deploy</span>
        </h2>
        <h3 class="text-lg font-medium mb-2 text-indigo-400">简单模式</h3>
        <pre style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="p-4 rounded-lg overflow-x-auto text-sm">
# 安装 deployctl
deno install -A jsr:@deno/deployctl

# 部署
deployctl deploy --project=your-project main.ts

# 设置环境变量 (在 Deno Deploy 控制台)
PROXY_API_KEY=your-key
REFRESH_TOKEN=your-token</pre>

        <h3 class="text-lg font-medium mb-2 mt-6 text-indigo-400">组合模式（推荐 - 无需配置 REFRESH_TOKEN）</h3>
        <pre style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text);" class="p-4 rounded-lg overflow-x-auto text-sm">
# 部署
deployctl deploy --project=your-project main.ts

# 设置环境变量 (在 Deno Deploy 控制台)
# 只需配置 PROXY_API_KEY
PROXY_API_KEY=your-key

# 用户在请求中传递 PROXY_API_KEY:REFRESH_TOKEN
# 支持多用户共享同一部署实例</pre>
      </section>

      <section class="card">
        <h2 class="text-2xl font-semibold mb-4">🔐 获取 Refresh Token</h2>
        <div style="background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(168, 85, 247, 0.1)); border: 1px solid var(--primary);" class="p-4 rounded-lg mb-4">
          <p class="text-sm font-semibold mb-2" style="color: var(--text);">✨ 推荐工具：Kiro Account Manager</p>
          <p class="text-sm mb-2" style="color: var(--text-muted);">
            使用 <a href="https://github.com/chaogei/Kiro-account-manager" class="text-indigo-400 hover:underline font-medium" target="_blank">Kiro Account Manager</a>
            可以轻松管理和获取 Refresh Token，无需手动抓包。
          </p>
          <a href="https://github.com/chaogei/Kiro-account-manager" target="_blank" class="inline-flex items-center gap-2 text-sm text-indigo-400 hover:text-indigo-300">
            <span>前往 GitHub 查看 →</span>
          </a>
        </div>

        <p class="text-sm mb-3" style="color: var(--text-muted);">或者手动获取：</p>
        <ol class="list-decimal list-inside space-y-2" style="color: var(--text-muted);">
          <li>安装并打开 <a href="https://kiro.dev/" class="text-indigo-400 hover:underline">Kiro IDE</a></li>
          <li>登录你的账号</li>
          <li>使用开发者工具或代理拦截流量</li>
          <li>查找发往 <code style="background: var(--bg-input); border: 1px solid var(--border);" class="px-2 py-1 rounded">prod.us-east-1.auth.desktop.kiro.dev/refreshToken</code> 的请求</li>
          <li>复制请求体中的 refreshToken 值</li>
        </ol>
      </section>
    </div>
  </main>

  ${COMMON_FOOTER}
</body>
</html>`;
}

function generateOpenAPISpec(): Record<string, unknown> {
  const msgSchema = { type: "object", required: ["role", "content"], properties: { role: { type: "string" }, content: { oneOf: [{ type: "string" }, { type: "array" }] } } };
  return {
    openapi: "3.1.0",
    info: { title: APP_TITLE, description: APP_DESCRIPTION, version: APP_VERSION },
    servers: [{ url: "/", description: "当前服务器" }],
    tags: [{ name: "Health" }, { name: "Models" }, { name: "Chat" }, { name: "Messages" }],
    paths: {
      "/health": { get: { tags: ["Health"], summary: "健康检查", responses: { "200": { description: "OK" } } } },
      "/v1/models": { get: { tags: ["Models"], summary: "模型列表", security: [{ BearerAuth: [] }], responses: { "200": { description: "模型列表" }, "401": { description: "未授权" } } } },
      "/v1/chat/completions": {
        post: {
          tags: ["Chat"], summary: "OpenAI 聊天补全", security: [{ BearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["model", "messages"], properties: { model: { type: "string", enum: AVAILABLE_MODELS }, messages: { type: "array", items: msgSchema }, stream: { type: "boolean" }, temperature: { type: "number" }, max_tokens: { type: "integer" }, tools: { type: "array" } } } } } },
          responses: { "200": { description: "成功" }, "400": { description: "请求无效" }, "401": { description: "未授权" } }
        }
      },
      "/v1/messages": {
        post: {
          tags: ["Messages"], summary: "Anthropic Messages API", security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["model", "messages", "max_tokens"], properties: { model: { type: "string", enum: AVAILABLE_MODELS }, messages: { type: "array", items: msgSchema }, max_tokens: { type: "integer" }, system: { type: "string" }, stream: { type: "boolean" }, temperature: { type: "number" }, tools: { type: "array" } } } } } },
          responses: { "200": { description: "成功" }, "400": { description: "请求无效" }, "401": { description: "未授权" } }
        }
      }
    },
    components: { securitySchemes: { BearerAuth: { type: "http", scheme: "bearer", description: "Bearer YOUR_API_KEY 或 Bearer YOUR_API_KEY:YOUR_REFRESH_TOKEN" }, ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key", description: "YOUR_API_KEY 或 YOUR_API_KEY:YOUR_REFRESH_TOKEN" } } }
  };
}

function renderSwaggerPage(): string {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>KiroGate - Swagger</title><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚀</text></svg>"><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"><style>body{margin:0;background:#fafafa}.swagger-ui .topbar{display:none}.hdr{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:1rem 2rem;display:flex;align-items:center;justify-content:space-between}.hdr h1{margin:0;font-size:1.5rem}.hdr a{color:#fff;text-decoration:none;opacity:.8;margin-left:1.5rem}.hdr a:hover{opacity:1}.badge{background:rgba(255,255,255,.2);padding:.25rem .5rem;border-radius:.25rem;font-size:.8rem;margin-left:1rem}</style></head><body><div class="hdr"><div style="display:flex;align-items:center"><h1>⚡ KiroGate API</h1><span class="badge">v${APP_VERSION}</span></div><nav><a href="/">首页</a><a href="/docs">文档</a><a href="/playground">Playground</a><a href="https://github.com/dext7r/KiroGate" target="_blank">GitHub</a></nav></div><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script><script>window.onload=function(){SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui",deepLinking:true,presets:[SwaggerUIBundle.presets.apis,SwaggerUIBundle.SwaggerUIStandalonePreset],layout:"BaseLayout",docExpansion:"list",filter:true})}</script></body></html>`;
}

function renderDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>${COMMON_HEAD}
<style>.mc{background:var(--bg-card);border:1px solid var(--border);border-radius:.75rem;padding:1rem;text-align:center}.mc:hover{border-color:var(--primary)}.mi{font-size:1.5rem;margin-bottom:.5rem}</style>
</head>
<body>
  ${COMMON_NAV}
  <main class="max-w-7xl mx-auto px-4 py-8">
    <div class="flex justify-between items-center mb-6">
      <h1 class="text-3xl font-bold">📊 Dashboard</h1>
      <button onclick="refreshData()" class="btn-primary">🔄 刷新</button>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      <div class="mc"><div class="mi">📈</div><div class="text-2xl font-bold text-indigo-400" id="totalRequests">-</div><div class="text-xs" style="color:var(--text-muted)">总请求</div></div>
      <div class="mc"><div class="mi">✅</div><div class="text-2xl font-bold text-green-400" id="successRate">-</div><div class="text-xs" style="color:var(--text-muted)">成功率</div></div>
      <div class="mc"><div class="mi">⏱️</div><div class="text-2xl font-bold text-yellow-400" id="avgResponseTime">-</div><div class="text-xs" style="color:var(--text-muted)">平均耗时</div></div>
      <div class="mc"><div class="mi">🕐</div><div class="text-2xl font-bold text-purple-400" id="uptime">-</div><div class="text-xs" style="color:var(--text-muted)">运行时长</div></div>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      <div class="mc"><div class="mi">⚡</div><div class="text-xl font-bold text-blue-400" id="streamRequests">-</div><div class="text-xs" style="color:var(--text-muted)">流式请求</div></div>
      <div class="mc"><div class="mi">💾</div><div class="text-xl font-bold text-cyan-400" id="nonStreamRequests">-</div><div class="text-xs" style="color:var(--text-muted)">非流式</div></div>
      <div class="mc"><div class="mi">❌</div><div class="text-xl font-bold text-red-400" id="failedRequests">-</div><div class="text-xs" style="color:var(--text-muted)">失败</div></div>
      <div class="mc"><div class="mi">🤖</div><div class="text-xl font-bold text-emerald-400" id="topModel">-</div><div class="text-xs" style="color:var(--text-muted)">热门模型</div></div>
    </div>
    <div class="grid grid-cols-2 gap-3 mb-6">
      <div class="mc"><div class="mi">🟢</div><div class="text-xl font-bold text-green-400" id="openaiRequests">-</div><div class="text-xs" style="color:var(--text-muted)">OpenAI API</div></div>
      <div class="mc"><div class="mi">🟣</div><div class="text-xl font-bold text-purple-400" id="anthropicRequests">-</div><div class="text-xs" style="color:var(--text-muted)">Anthropic API</div></div>
    </div>
    <div class="grid lg:grid-cols-2 gap-4 mb-6">
      <div class="card"><h2 class="text-lg font-semibold mb-3">📈 耗时趋势</h2><div id="latencyChart" style="height:250px"></div></div>
      <div class="card"><h2 class="text-lg font-semibold mb-3">📊 状态分布</h2><div style="height:250px;position:relative"><canvas id="statusChart"></canvas></div></div>
    </div>
    <div class="card">
      <h2 class="text-lg font-semibold mb-3">📋 最近请求</h2>
      <div class="table-responsive"><table class="w-full text-xs"><thead><tr class="text-left" style="color:var(--text-muted);border-bottom:1px solid var(--border)"><th class="py-2 px-2">时间</th><th class="py-2 px-2">API</th><th class="py-2 px-2">路径</th><th class="py-2 px-2">状态</th><th class="py-2 px-2">耗时</th><th class="py-2 px-2">模型</th></tr></thead><tbody id="recentRequestsTable"><tr><td colspan="6" class="py-4 text-center" style="color:var(--text-muted)">加载中...</td></tr></tbody></table></div>
    </div>
  </main>
  ${COMMON_FOOTER}
  <script>
let lc,sc;
async function refreshData(){try{const r=await fetch('/api/metrics'),d=await r.json();document.getElementById('totalRequests').textContent=d.totalRequests||0;document.getElementById('successRate').textContent=d.totalRequests>0?((d.successRequests/d.totalRequests)*100).toFixed(1)+'%':'0%';document.getElementById('avgResponseTime').textContent=(d.avgResponseTime||0).toFixed(0)+'ms';const u=Math.floor((Date.now()-d.startTime)/1000);document.getElementById('uptime').textContent=Math.floor(u/3600)+'h '+Math.floor((u%3600)/60)+'m';document.getElementById('streamRequests').textContent=d.streamRequests||0;document.getElementById('nonStreamRequests').textContent=d.nonStreamRequests||0;document.getElementById('failedRequests').textContent=d.failedRequests||0;const m=Object.entries(d.modelUsage||{}).sort((a,b)=>b[1]-a[1])[0];document.getElementById('topModel').textContent=m?m[0].split('-').slice(-2).join('-'):'-';document.getElementById('openaiRequests').textContent=(d.apiTypeUsage||{}).openai||0;document.getElementById('anthropicRequests').textContent=(d.apiTypeUsage||{}).anthropic||0;const rt=d.responseTimes||[];lc.setOption({xAxis:{data:rt.map((_,i)=>i+1)},series:[{data:rt}]});sc.data.datasets[0].data=[d.successRequests||0,d.failedRequests||0];sc.update();const rq=(d.recentRequests||[]).slice(0,10),tb=document.getElementById('recentRequestsTable');tb.innerHTML=rq.length?rq.map(q=>'<tr style="border-bottom:1px solid var(--border)"><td class="py-2 px-2">'+new Date(q.timestamp).toLocaleTimeString()+'</td><td class="py-2 px-2"><span class="text-xs px-1 rounded '+(q.apiType==='anthropic'?'bg-purple-600':'bg-green-600')+' text-white">'+q.apiType+'</span></td><td class="py-2 px-2 font-mono">'+q.path+'</td><td class="py-2 px-2 '+(q.status<400?'text-green-400':'text-red-400')+'">'+q.status+'</td><td class="py-2 px-2">'+q.duration.toFixed(0)+'ms</td><td class="py-2 px-2">'+(q.model||'-')+'</td></tr>').join(''):'<tr><td colspan="6" class="py-4 text-center" style="color:var(--text-muted)">暂无</td></tr>'}catch(e){console.error(e)}}
lc=echarts.init(document.getElementById('latencyChart'));lc.setOption({tooltip:{trigger:'axis'},xAxis:{type:'category',data:[],axisLabel:{color:'#94a3b8'}},yAxis:{type:'value',name:'ms',axisLabel:{color:'#94a3b8'}},series:[{type:'line',smooth:true,data:[],areaStyle:{color:'rgba(99,102,241,0.2)'},lineStyle:{color:'#6366f1'}}]});
sc=new Chart(document.getElementById('statusChart'),{type:'doughnut',data:{labels:['成功','失败'],datasets:[{data:[0,0],backgroundColor:['#22c55e','#ef4444'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{color:'#94a3b8'}}}}});
refreshData();setInterval(refreshData,5000);window.addEventListener('resize',()=>lc.resize());
  </script>
</body>
</html>`;
}

// ============================================================================
// HTTP 服务器路由处理
// ============================================================================

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const startTime = Date.now();

  logger.info(`${method} ${path}`);

  let response: Response;
  let model = "";
  let isStream = false;
  let apiType: "openai" | "anthropic" | undefined;
  let errorMessage: string | undefined;

  try {
    // 静态页面路由
    if (method === "GET") {
      switch (path) {
        case "/":
          response = new Response(renderHomePage(), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
          break;
        case "/docs":
          response = new Response(renderDocsPage(), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
          break;
        case "/playground":
          response = new Response(renderPlaygroundPage(), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
          break;
        case "/deploy":
          response = new Response(renderDeployPage(), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
          break;
        case "/dashboard":
          response = new Response(renderDashboardPage(), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
          break;
        case "/swagger":
          response = new Response(renderSwaggerPage(), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
          break;
        case "/openapi.json":
          response = Response.json(generateOpenAPISpec());
          break;
        case "/health":
          response = Response.json({
            status: "healthy",
            timestamp: new Date().toISOString(),
            version: APP_VERSION,
          });
          break;
        case "/api/metrics":
          response = Response.json(metrics);
          break;
        case "/v1/models":
          // 验证 API Key
          if (!verifyApiKey(req)) {
            response = Response.json({ error: "Unauthorized" }, { status: 401 });
            break;
          }
          response = Response.json({
            object: "list",
            data: AVAILABLE_MODELS.map(m => ({
              id: m,
              object: "model",
              created: Math.floor(Date.now() / 1000),
              owned_by: "anthropic",
            })),
          });
          break;
        default:
          response = Response.json({ error: "Not Found" }, { status: 404 });
      }
    }
    // API 路由
    else if (method === "POST") {
      if (path === "/v1/chat/completions") {
        apiType = "openai";
        // 在消费请求体之前提取元数据
        try {
          const bodyText = await req.text();
          const body = JSON.parse(bodyText);
          model = body.model || "";
          isStream = body.stream || false;

          // 创建新的 Request 对象供 handler 使用
          const newReq = new Request(req.url, {
            method: req.method,
            headers: req.headers,
            body: bodyText,
          });
          response = await handleChatCompletions(newReq);

          if (isStream) metrics.streamRequests++;
          else metrics.nonStreamRequests++;
        } catch (e) {
          logger.error(`Failed to parse request: ${e}`);
          response = Response.json({
            error: { message: "Invalid JSON in request body", type: "invalid_request_error" },
          }, { status: 400 });
        }
      } else if (path === "/v1/messages" || path === "/messages") {
        apiType = "anthropic";
        // 同时支持 /v1/messages 和 /messages (Anthropic SDK 兼容)
        try {
          const bodyText = await req.text();
          const body = JSON.parse(bodyText);
          model = body.model || "";
          isStream = body.stream || false;

          // 创建新的 Request 对象供 handler 使用
          const newReq = new Request(req.url, {
            method: req.method,
            headers: req.headers,
            body: bodyText,
          });
          response = await handleAnthropicMessages(newReq);

          if (isStream) metrics.streamRequests++;
          else metrics.nonStreamRequests++;
        } catch (e) {
          logger.error(`Failed to parse request: ${e}`);
          response = Response.json({
            type: "error",
            error: { type: "invalid_request_error", message: "Invalid JSON in request body" },
          }, { status: 400 });
        }
      } else {
        response = Response.json({ error: "Not Found" }, { status: 404 });
      }
    } else {
      response = Response.json({ error: "Method Not Allowed" }, { status: 405 });
    }

    // 记录请求（只记录模型相关接口）
    const duration = Date.now() - startTime;
    const isModelEndpoint = path === "/v1/chat/completions" || path === "/v1/messages" || path === "/messages";
    if (isModelEndpoint) {
      // 如果响应状态码表示错误，尝试提取错误信息
      if (response.status >= 400) {
        try {
          const clonedResponse = response.clone();
          const errorBody = await clonedResponse.text();
          try {
            const errorJson = JSON.parse(errorBody);
            errorMessage = errorJson.error?.message || errorJson.message || errorBody.slice(0, 200);
          } catch {
            errorMessage = errorBody.slice(0, 200);
          }
        } catch {
          errorMessage = `HTTP ${response.status}`;
        }
      }
      await recordRequest({
        timestamp: Date.now(),
        method,
        path,
        status: response.status,
        duration,
        model,
        apiType,
        error: errorMessage,
      });
    }

    return response;

  } catch (e) {
    logger.error(`Request error: ${e}`);
    const duration = Date.now() - startTime;
    const isModelEndpoint = path === "/v1/chat/completions" || path === "/v1/messages" || path === "/messages";
    if (isModelEndpoint) {
      await recordRequest({
        timestamp: Date.now(),
        method,
        path,
        status: 500,
        duration,
        model,
        apiType,
        error: String(e),
      });
    }
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// 用户认证信息缓存
interface UserAuth {
  refreshToken: string;
  authManager: KiroAuthManager;
}

const userAuthCache = new Map<string, UserAuth>();

/**
 * 验证 API Key 并提取用户的 refresh token
 * 支持两种格式：
 * 1. 简单格式：PROXY_API_KEY（使用全局配置的 REFRESH_TOKEN）
 * 2. 组合格式：PROXY_API_KEY:REFRESH_TOKEN（用户自带 refresh token）
 */
function verifyApiKey(req: Request): { valid: boolean; refreshToken?: string; apiKey?: string } {
  const authHeader = req.headers.get("Authorization");
  const xApiKey = req.headers.get("x-api-key");

  // 提取 Bearer token
  let token = "";
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  // 优先使用 x-api-key，其次使用 Authorization Bearer token
  const providedKey = xApiKey || token;

  if (!providedKey) {
    return { valid: false };
  }

  // 检查是否包含 : 分隔符（组合格式）
  if (providedKey.includes(":")) {
    const parts = providedKey.split(":");
    if (parts.length === 2) {
      const [apiKey, refreshToken] = parts;

      // 验证 API Key 部分
      if (apiKey === settings.proxyApiKey) {
        logger.debug(`Multi-tenant mode: PROXY_API_KEY:REFRESH_TOKEN (token: ${maskToken(refreshToken)})`);
        return { valid: true, refreshToken, apiKey };
      }
    }
  }

  // 简单格式：只验证 API Key
  if (providedKey === settings.proxyApiKey) {
    logger.debug("Traditional mode: PROXY_API_KEY only");
    return { valid: true, apiKey: providedKey };
  }

  logger.warning(`Invalid API key: ${maskToken(providedKey)}`);
  return { valid: false };
}

/**
 * 获取或创建用户专属的认证管理器
 */
async function getUserAuthManager(refreshToken?: string): Promise<KiroAuthManager> {
  // 如果没有提供 refreshToken，使用全局的 authManager
  if (!refreshToken) {
    return authManager;
  }

  // 检查缓存
  const cacheKey = refreshToken.slice(0, 16); // 使用前16个字符作为缓存键
  const cached = userAuthCache.get(cacheKey);
  if (cached && cached.refreshToken === refreshToken) {
    return cached.authManager;
  }

  // 创建新的认证管理器
  logger.info(`Creating new auth manager for user: ${maskToken(refreshToken)}`);
  const userAuthMgr = new KiroAuthManager(
    refreshToken,
    settings.profileArn,
    settings.region,
    ""
  );
  await userAuthMgr.init();

  // 缓存
  userAuthCache.set(cacheKey, { refreshToken, authManager: userAuthMgr });

  // 限制缓存大小（最多100个用户）
  if (userAuthCache.size > 100) {
    const firstKey = userAuthCache.keys().next().value;
    userAuthCache.delete(firstKey);
    logger.debug(`Auth cache size limit reached, removed oldest entry`);
  }

  return userAuthMgr;
}

async function handleChatCompletions(req: Request): Promise<Response> {
  const authResult = verifyApiKey(req);
  if (!authResult.valid) {
    return Response.json({ error: { message: "Invalid or missing API Key" } }, { status: 401 });
  }

  let body: ChatCompletionRequest;
  try {
    body = await req.json() as ChatCompletionRequest;
  } catch (e) {
    logger.error(`Failed to parse request body: ${e}`);
    return Response.json({
      error: { message: "Invalid JSON in request body", type: "invalid_request_error" },
    }, { status: 400 });
  }

  logger.info(`Chat completions: model=${body.model}, stream=${body.stream}, messages=${body.messages?.length || 0}`);

  const conversationId = generateConversationId();

  try {
    // 获取用户专属的认证管理器
    const userAuthMgr = await getUserAuthManager(authResult.refreshToken);

    const kiroPayload = buildKiroPayload(body, conversationId, userAuthMgr.profile);
    const kiroUrl = `${userAuthMgr.apiHost}/generateAssistantResponse`;

    logger.debug(`Sending request to Kiro API: ${kiroUrl}`);
    const response = await requestWithRetry(userAuthMgr, kiroUrl, kiroPayload, true);

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Kiro API error: ${response.status} - ${errorText}`);

      // 尝试解析错误响应
      let errorMessage = errorText;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.message) {
          errorMessage = errorJson.message;
          if (errorJson.reason) {
            errorMessage += ` (reason: ${errorJson.reason})`;
          }
        }
      } catch {
        // 忽略 JSON 解析错误
      }

      return Response.json({
        error: { message: errorMessage, type: "kiro_api_error", code: response.status },
      }, { status: response.status });
    }

    if (body.stream) {
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          try {
            for await (const chunk of streamKiroToOpenAI(response, body.model)) {
              controller.enqueue(encoder.encode(chunk));
            }
          } catch (e) {
            logger.error(`Streaming error: ${e}`);
            const errorChunk = `data: ${JSON.stringify({ error: String(e) })}\n\n`;
            controller.enqueue(encoder.encode(errorChunk));
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    } else {
      const result = await collectStreamResponse(response, body.model);
      return Response.json(result);
    }

  } catch (e) {
    logger.error(`Chat completions error: ${e}`);
    return Response.json({
      error: { message: String(e), type: "internal_error" },
    }, { status: 500 });
  }
}

async function handleAnthropicMessages(req: Request): Promise<Response> {
  const authResult = verifyApiKey(req);
  if (!authResult.valid) {
    return Response.json({
      type: "error",
      error: { type: "authentication_error", message: "Invalid or missing API Key" },
    }, { status: 401 });
  }

  let body: AnthropicMessagesRequest;
  try {
    body = await req.json() as AnthropicMessagesRequest;
  } catch (e) {
    logger.error(`Failed to parse request body: ${e}`);
    return Response.json({
      type: "error",
      error: { type: "invalid_request_error", message: "Invalid JSON in request body" },
    }, { status: 400 });
  }

  logger.info(`Anthropic messages: model=${body.model}, stream=${body.stream}, messages=${body.messages?.length || 0}`);

  // 转换为 OpenAI 格式
  const openaiRequest = convertAnthropicToOpenAI(body);
  const conversationId = generateConversationId();

  try {
    // 获取用户专属的认证管理器
    const userAuthMgr = await getUserAuthManager(authResult.refreshToken);

    const kiroPayload = buildKiroPayload(openaiRequest, conversationId, userAuthMgr.profile);
    const kiroUrl = `${userAuthMgr.apiHost}/generateAssistantResponse`;

    logger.debug(`Sending request to Kiro API: ${kiroUrl}`);
    const response = await requestWithRetry(userAuthMgr, kiroUrl, kiroPayload, true);

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Kiro API error: ${response.status} - ${errorText}`);

      // 尝试解析错误响应
      let errorMessage = errorText;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.message) {
          errorMessage = errorJson.message;
          if (errorJson.reason) {
            errorMessage += ` (reason: ${errorJson.reason})`;
          }
        }
      } catch {
        // 忽略 JSON 解析错误
      }

      return Response.json({
        type: "error",
        error: { type: "api_error", message: errorMessage },
      }, { status: response.status });
    }

    if (body.stream) {
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          try {
            for await (const chunk of streamKiroToAnthropic(response, body.model)) {
              controller.enqueue(encoder.encode(chunk));
            }
          } catch (e) {
            logger.error(`Streaming error: ${e}`);
            const errorEvent = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: String(e) } })}\n\n`;
            controller.enqueue(encoder.encode(errorEvent));
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    } else {
      const result = await collectAnthropicResponse(response, body.model);
      return Response.json(result);
    }

  } catch (e) {
    logger.error(`Anthropic messages error: ${e}`);
    return Response.json({
      type: "error",
      error: { type: "api_error", message: String(e) },
    }, { status: 500 });
  }
}

// ============================================================================
// 应用启动
// ============================================================================

// 全局认证管理器
let authManager: KiroAuthManager;

async function main() {
  // 配置验证
  if (!settings.refreshToken && !settings.ssoCacheDir) {
    console.error("=".repeat(60));
    console.error("  CONFIGURATION ERROR");
    console.error("=".repeat(60));
    console.error("  No Kiro credentials configured!");
    console.error("");
    console.error("  Set one of:");
    console.error("    REFRESH_TOKEN=your_refresh_token");
    console.error("    SSO_CACHE_DIR=path/to/.aws/sso/cache");
    console.error("=".repeat(60));
    Deno.exit(1);
  }

  // 初始化认证管理器
  authManager = new KiroAuthManager(
    settings.refreshToken,
    settings.profileArn,
    settings.region,
    settings.ssoCacheDir
  );
  await authManager.init();

  // 加载持久化的监控数据
  await loadMetricsFromKV();

  logger.info(`KiroGate v${APP_VERSION} starting...`);
  logger.info(`Region: ${settings.region}`);
  logger.info(`Port: ${settings.port}`);

  // 启动定期持久化任务（每30秒检查一次）
  const persistInterval = setInterval(async () => {
    await persistMetricsIfNeeded();
  }, 30000);

  // 监听进程退出信号，确保数据持久化
  const handleShutdown = async () => {
    logger.info("Shutting down gracefully...");
    clearInterval(persistInterval);
    await forcePersistMetrics();
    Deno.exit(0);
  };

  // 注册退出信号处理
  Deno.addSignalListener("SIGINT", handleShutdown);
  Deno.addSignalListener("SIGTERM", handleShutdown);

  // 启动服务器
  Deno.serve({ port: settings.port }, handleRequest);
}

main();
