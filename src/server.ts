import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PipedriveClient, type PipedriveClientOptions } from './pipedrive/client.js';
import { registerTools } from './tools/pipedrive.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: PipedriveClient;
  clientOptions?: PipedriveClientOptions;
}

let defaultClient: PipedriveClient | undefined;

/**
 * Process-wide client built from the environment. Sharing it means the
 * outbound concurrency limit applies across all sessions, also when a server
 * instance is created per HTTP request.
 */
export function getDefaultClient(): PipedriveClient {
  defaultClient ??= new PipedriveClient();
  return defaultClient;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'pipedrive',
    version: PACKAGE_VERSION,
  });

  const client =
    options.client ?? (options.clientOptions ? new PipedriveClient(options.clientOptions) : getDefaultClient());
  registerTools(server, client);

  return server;
}
