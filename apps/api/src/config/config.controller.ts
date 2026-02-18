import { Controller, Get } from '@nestjs/common';
import { ConfigService } from './config.service';

/**
 * Public runtime configuration endpoint for frontend clients.
 * Values are sourced from ConfigService (Firestore latest deployment first,
 * then environment-variable fallback).
 */
@Controller('config')
export class ConfigController {
  constructor(private readonly configService: ConfigService) {}

  @Get('public')
  getPublicConfig() {
    const cfg = this.configService.getAll();
    return {
      network: cfg.network,
      rpcUrl: cfg.rpcUrl,
      heistContractId: cfg.heistContractId,
      zkVerifierContractId: cfg.zkVerifierContractId,
      vkHash: cfg.vkHash,
    };
  }
}

