import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { registerAs } from '@nestjs/config';

export interface NetworkContracts {
  network: string;
  networkPassphrase: string;
  pool: string;
  commitment: string;
  nullifier: string;
  enabled: boolean;
}

export interface NetworksConfig {
  rpcUrl: string;
  startLedger: number;
  merkleWasmDir: string;
  networks: NetworkContracts[];
}

interface DeploymentsFile {
  network: string;
  network_passphrase?: string;
  contracts: {
    pool: string;
    commitment: string;
    nullifier: string;
  };
}

function loadDeployments(path: string): NetworkContracts {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new Error(`DEPLOYMENTS_PATH not found: ${abs}`);
  }
  const raw = JSON.parse(readFileSync(abs, 'utf8')) as DeploymentsFile;
  if (!raw.contracts?.pool || !raw.contracts?.commitment || !raw.contracts?.nullifier) {
    throw new Error(`Invalid deployments file (missing contracts): ${abs}`);
  }
  return {
    network: raw.network || 'testnet',
    networkPassphrase:
      raw.network_passphrase ?? 'Test SDF Network ; September 2015',
    pool: raw.contracts.pool,
    commitment: raw.contracts.commitment,
    nullifier: raw.contracts.nullifier,
    enabled: true,
  };
}

export default registerAs('networks', (): NetworksConfig => {
  const deploymentsPath = process.env.DEPLOYMENTS_PATH?.trim();
  if (!deploymentsPath) {
    throw new Error('DEPLOYMENTS_PATH is required');
  }
  const testnet = loadDeployments(deploymentsPath);
  return {
    rpcUrl:
      process.env.SOROBAN_RPC_URL?.trim() ||
      'https://soroban-testnet.stellar.org',
    startLedger: parseInt(process.env.INDEXER_START_LEDGER ?? '1', 10),
    merkleWasmDir: process.env.MERKLE_WASM_DIR?.trim() ?? '',
    networks: [testnet],
  };
});
