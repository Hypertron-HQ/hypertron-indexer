import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(4002),
  CORS_ORIGINS: Joi.string().default('http://localhost:3000'),

  DATABASE_URL: Joi.string().required(),
  REDIS_URL: Joi.string().default('redis://localhost:6379'),

  SOROBAN_RPC_URL: Joi.string()
    .uri()
    .default('https://soroban-testnet.stellar.org'),
  DEPLOYMENTS_PATH: Joi.string().required(),
  INDEXER_START_LEDGER: Joi.number().integer().min(1).required(),
  DISABLE_INGEST: Joi.boolean().truthy('true').falsy('false').default(false),
  /** Optional path to prover-wasm pkg for local merkle_root; falls back to contract-only checks */
  MERKLE_WASM_DIR: Joi.string().allow('').default(''),
});
