import fs from 'node:fs';
import net from 'node:net';
import { X509Certificate } from 'node:crypto';
import { proposalSourceSchema } from '@finance-app/shared';

// All runtime options come from environment variables and are validated here,
// once, at startup. See docs/MCP.md for the full list.

export type TlsConfig = { cert: Buffer; key: Buffer; fingerprint256: string };

export type HttpConfig = {
  host: string;
  port: number;
  token: string;
  tls: TlsConfig | null;
  /** null = any client address allowed (token still required). */
  allowedClients: net.BlockList | null;
};

export type Config = {
  apiUrl: string;
  proposalSource: string;
  disabledTools: ReadonlySet<string>;
  transport: { kind: 'stdio' } | ({ kind: 'http' } & HttpConfig);
};

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => Buffer;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
export const MIN_TOKEN_LENGTH = 32;
const DEFAULT_PORT = 3030;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseUrl(value: string, name: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new ConfigError(`${name} must be an http(s) URL, got "${value}"`);
  }
}

function parseProposalSource(value: string | undefined) {
  const parsed = proposalSourceSchema.safeParse(value ?? 'hermes');
  if (!parsed.success) throw new ConfigError(`Invalid MCP_PROPOSAL_SOURCE: "${value}" (1–40 characters)`);
  return parsed.data;
}

function parsePort(value: string | undefined) {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`Invalid MCP_PORT: "${value}"`);
  return port;
}

function readToken(env: Env, readFile: ReadFile) {
  // A token file keeps the secret out of unit files and the process environment.
  const token = env.MCP_TOKEN_FILE ? readFile(env.MCP_TOKEN_FILE).toString('utf8').trim() : (env.MCP_TOKEN ?? '').trim();
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `MCP_TOKEN_FILE or MCP_TOKEN with at least ${MIN_TOKEN_LENGTH} characters is required for MCP_TRANSPORT=http`
    );
  }
  return token;
}

function readTls(env: Env, readFile: ReadFile, host: string): TlsConfig | null {
  const { MCP_TLS_CERT: certPath, MCP_TLS_KEY: keyPath } = env;
  if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('Set both MCP_TLS_CERT and MCP_TLS_KEY, or neither');
  if (!certPath || !keyPath) {
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new ConfigError(
        `Refusing plain HTTP on ${host}: set MCP_TLS_CERT and MCP_TLS_KEY (see apps/mcp/scripts/gen-cert.sh)`
      );
    }
    return null;
  }
  const cert = readFile(certPath);
  return { cert, key: readFile(keyPath), fingerprint256: new X509Certificate(cert).fingerprint256 };
}

/** Accepts single addresses and CIDR ranges, IPv4 and IPv6: "10.0.0.5, 192.168.1.0/24". */
export function parseAllowedClients(value: string | undefined): net.BlockList | null {
  const entries = list(value);
  if (entries.length === 0) return null;
  const blockList = new net.BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split('/');
    const family = net.isIPv4(address) ? 'ipv4' : net.isIPv6(address) ? 'ipv6' : null;
    if (!family) throw new ConfigError(`Invalid address in MCP_ALLOWED_IPS: "${entry}"`);
    if (prefix === undefined) {
      blockList.addAddress(address, family);
      continue;
    }
    const bits = Number(prefix);
    const max = family === 'ipv4' ? 32 : 128;
    if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new ConfigError(`Invalid prefix in MCP_ALLOWED_IPS: "${entry}"`);
    blockList.addSubnet(address, bits, family);
  }
  return blockList;
}

export function loadConfig(env: Env, readFile: ReadFile = (p) => fs.readFileSync(p)): Config {
  const base = {
    apiUrl: parseUrl(env.FINANCE_API_URL ?? 'http://127.0.0.1:3001', 'FINANCE_API_URL'),
    proposalSource: parseProposalSource(env.MCP_PROPOSAL_SOURCE),
    disabledTools: new Set(list(env.MCP_DISABLED_TOOLS)),
  };

  const kind = env.MCP_TRANSPORT ?? 'stdio';
  if (kind === 'stdio') return { ...base, transport: { kind } };
  if (kind !== 'http') throw new ConfigError(`MCP_TRANSPORT must be "stdio" or "http", got "${kind}"`);

  const host = env.MCP_HOST ?? '127.0.0.1';
  return {
    ...base,
    transport: {
      kind,
      host,
      port: parsePort(env.MCP_PORT),
      token: readToken(env, readFile),
      tls: readTls(env, readFile, host),
      allowedClients: parseAllowedClients(env.MCP_ALLOWED_IPS),
    },
  };
}
