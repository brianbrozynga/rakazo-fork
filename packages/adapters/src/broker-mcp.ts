import { McpSession } from "./mcp-transport.js";

export type BrokerSessionOptions = {
  url: string;
  key: string;
  signal: AbortSignal;
};

export async function createBrokerSession(opts: BrokerSessionOptions): Promise<McpSession> {
  const session = new McpSession();
  try {
    await session.connectRemote({
      url: opts.url,
      urlPolicy: { allowHttpLocalhost: true, allowLocalHttpCredentials: true },
      headerPolicy: { headers: { Authorization: `Bearer ${opts.key}` } },
      fallbackToSse: false,
      signal: opts.signal,
    });
  } catch (err) {
    void session.close().catch(() => undefined);
    throw err;
  }
  return session;
}
