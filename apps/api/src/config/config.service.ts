import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DeploymentService } from '@repo/database';

/** Runtime contract configuration resolved at startup. */
export interface AppConfig {
  /** Stellar network identifier ("testnet" | "mainnet"). */
  network: string;
  /** Soroban RPC endpoint. */
  rpcUrl: string;
  /** Heist game contract ID. */
  heistContractId: string;
  /** ZK Verifier contract ID. */
  zkVerifierContractId: string;
  /** VK hash registered on the verifier. */
  vkHash: string;
  /** Game Hub contract ID. */
  gameHub: string;
}

/**
 * Resolves runtime contract addresses at application startup.
 *
 * Resolution order:
 *  1. Latest `deployments` record in Firestore for the current network.
 *  2. Environment variables (HEIST_CONTRACT_ID, ZK_VERIFIER_CONTRACT_ID, …).
 *
 * This means you never need to manually update .env files after a deploy —
 * the script writes to Firestore and the API picks it up automatically.
 */
@Injectable()
export class ConfigService implements OnModuleInit {
  private readonly logger = new Logger(ConfigService.name);
  private config: AppConfig;

  constructor(private readonly deploymentService: DeploymentService) {
    // Initialize immediately with env fallback so dependent services can safely
    // read config during their own onModuleInit lifecycle.
    this.config = this.buildEnvFallback(
      process.env.STELLAR_NETWORK ?? 'testnet',
    );
  }

  private buildEnvFallback(network: string): AppConfig {
    return {
      network,
      rpcUrl:
        process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org',
      heistContractId: process.env.HEIST_CONTRACT_ID ?? '',
      zkVerifierContractId: process.env.ZK_VERIFIER_CONTRACT_ID ?? '',
      vkHash: process.env.VK_HASH ?? '',
      gameHub:
        process.env.GAME_HUB_CONTRACT_ID ??
        'CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG',
    };
  }

  async onModuleInit(): Promise<void> {
    const network = process.env.STELLAR_NETWORK ?? 'testnet';

    try {
      const latest = await this.deploymentService.getLatest(network);

      if (latest) {
        this.logger.log(
          `Loaded deployment from Firestore [${network}]: ${latest.id}` +
            ` — heist=${latest.heistContractId.slice(0, 8)}…`,
        );
        this.config = {
          network,
          rpcUrl:
            process.env.SOROBAN_RPC_URL ??
            'https://soroban-testnet.stellar.org',
          heistContractId: latest.heistContractId,
          zkVerifierContractId: latest.zkVerifierContractId,
          vkHash: latest.vkHash,
          gameHub: latest.gameHub,
        };
        return;
      }

      this.logger.warn(
        `No Firestore deployment found for network "${network}", falling back to env vars.`,
      );
    } catch (err) {
      this.logger.warn(
        `Firestore deployment read failed — falling back to env vars. Reason: ${err}`,
      );
    }

    // Keep / refresh env fallback.
    this.config = this.buildEnvFallback(network);

    this.logger.log(
      `Using env config [${network}]: heist=${this.config.heistContractId.slice(0, 8) || '(unset)'}…`,
    );
  }

  /** Retrieve a single config key. */
  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key];
  }

  /** Retrieve the full config object (read-only). */
  getAll(): Readonly<AppConfig> {
    return this.config;
  }
}
