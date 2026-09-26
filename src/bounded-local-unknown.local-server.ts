/// <reference types="node" />
/**
 * A real loopback HTTP server that speaks the subset of the Ollama
 * `/api/generate` wire protocol used by `runBoundedLocalUnknown`.
 *
 * Test support only (not exported from the package entry point). It is a real
 * collaborator: requests travel through the platform `fetch`, a real TCP
 * socket and a real `node:http` server, and every assertion is made on the
 * state the server recorded (bodies received, hit counts), never on calls to
 * an injected function.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

export type LocalServerHandler = (
  request: RecordedRequest,
  response: ServerResponse,
  hitIndex: number,
) => void | Promise<void>;

export interface LocalOllamaServer {
  origin: string;
  baseURL: string;
  requests: RecordedRequest[];
  setHandler(handler: LocalServerHandler): void;
  close(): Promise<void>;
}

export function ollamaJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

export const defaultGenerate: LocalServerHandler = (request, response) => {
  const parsed = JSON.parse(request.body) as { prompt: string };
  ollamaJson(response, 200, {
    response: `candidate:${parsed.prompt}`,
    prompt_eval_count: 11,
    eval_count: 7,
    total_duration: 123,
  });
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export async function startLocalOllamaServer(
  handler: LocalServerHandler = defaultGenerate,
  host = '127.0.0.1',
): Promise<LocalOllamaServer> {
  let current = handler;
  const requests: RecordedRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();

  const server: Server = createServer(async (req, res) => {
    const recorded: RecordedRequest = {
      method: req.method ?? '',
      path: req.url ?? '',
      body: await readBody(req),
    };
    requests.push(recorded);
    try {
      await current(recorded, res, requests.length - 1);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>(resolve => server.listen(0, host, () => resolve()));
  const { port } = server.address() as AddressInfo;
  const hostPart = host.includes(':') ? `[${host}]` : host;
  const origin = `http://${hostPart}:${port}`;

  return {
    origin,
    baseURL: `${origin}/api`,
    requests,
    setHandler(next) {
      current = next;
    },
    close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      return new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
