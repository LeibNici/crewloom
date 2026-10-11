import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * 本机受控写服务（组 B 验证用）。
 *
 * 为什么需要它：产品允许**真实用户主动保存**，但本任务禁止对 13000 发起任何写入。
 * 因此受控写验证在本机起一个真实 HTTP 服务（不是 axios adapter），
 * 让请求真的经过 SDK 请求管线与传输层，再断言**精确的路径、方法、查询串与请求体**。
 *
 * 边界：
 *  - 只绑定 127.0.0.1 的随机端口，随测试结束关闭；
 *  - 只记录方法与路径（相对 /api），凭据类请求头只记录是否存在，不记录值；
 *  - 不连接任何外部系统。
 */

export interface RecordedRequest {
  method: string;
  /** 去掉 /api 前缀的路径，例如 `users:create` 或 `roles/member/users:add`。 */
  path: string;
  /** 完整路径（含 /api 前缀）。 */
  fullPath: string;
  query: Record<string, string | string[]>;
  /** 解析后的请求体（JSON 或原文）。 */
  body: unknown;
  /** 原始请求体字符串。 */
  rawBody: string;
  contentType: string | undefined;
  hasAuthorization: boolean;
  dataSourceHeader: string | undefined;
}

export interface ControlledReply {
  status?: number;
  body?: unknown;
}

export interface ControlledServer {
  /** 例如 `http://127.0.0.1:41234/api`。 */
  baseURL: string;
  /** 例如 `http://127.0.0.1:41234`。 */
  origin: string;
  requests: RecordedRequest[];
  /** 设置应答器；缺省对任何请求返回 `{data: []}`。可以是异步的（用于模拟慢响应）。 */
  respond: (handler: (request: RecordedRequest) => ControlledReply | Promise<ControlledReply>) => void;
  reset: () => void;
  close: () => Promise<void>;
}

function parseQuery(url: string): Record<string, string | string[]> {
  const index = url.indexOf('?');
  if (index < 0) return {};
  const params = new URLSearchParams(url.slice(index + 1));
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startControlledServer(): Promise<ControlledServer> {
  const requests: RecordedRequest[] = [];
  let handler: (request: RecordedRequest) => ControlledReply | Promise<ControlledReply> = () => ({
    body: { data: [] },
  });

  const server: Server = createServer((request, response) => {
    void (async () => {
      const corsHeaders = {
        'Access-Control-Allow-Origin': request.headers.origin ?? '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Expose-Headers': 'x-new-token',
      };
      // jsdom 的 XHR 会为带自定义头的请求发预检；受控服务直接应答，便于在浏览器环境里验证真实请求头。
      if ((request.method ?? '').toUpperCase() === 'OPTIONS') {
        response.writeHead(204, corsHeaders);
        response.end();
        return;
      }

      const rawBody = await readBody(request);
      const url = request.url ?? '/';
      const fullPath = url.split('?')[0];
      const withoutPrefix = fullPath.startsWith('/api') ? fullPath.slice('/api'.length) : fullPath;
      const path = withoutPrefix.replace(/^\/+/, '');
      let body: unknown = rawBody;
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody;
        }
      } else {
        body = undefined;
      }
      const recorded: RecordedRequest = {
        method: (request.method ?? 'GET').toUpperCase(),
        path,
        fullPath,
        query: parseQuery(url),
        body,
        rawBody,
        contentType: request.headers['content-type'] as string | undefined,
        hasAuthorization: Boolean(request.headers.authorization),
        dataSourceHeader: request.headers['x-data-source'] as string | undefined,
      };
      requests.push(recorded);

      let reply: ControlledReply;
      try {
        reply = await handler(recorded);
      } catch (error) {
        reply = { status: 500, body: { errors: [{ message: String(error) }] } };
      }
      const status = reply.status ?? 200;
      const payload = reply.body === undefined ? { data: [] } : reply.body;
      response.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders });
      response.end(JSON.stringify(payload));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    baseURL: `${origin}/api`,
    origin,
    requests,
    respond: (next) => {
      handler = next;
    },
    reset: () => {
      requests.length = 0;
      handler = () => ({ body: { data: [] } });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** 取最近一次匹配路径的请求。 */
export function lastRequest(server: ControlledServer, path: string): RecordedRequest | undefined {
  for (let index = server.requests.length - 1; index >= 0; index -= 1) {
    if (server.requests[index].path === path) return server.requests[index];
  }
  return undefined;
}
