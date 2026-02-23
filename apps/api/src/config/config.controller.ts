import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from './config.service';

/**
 * Public runtime configuration endpoint for frontend clients.
 * Values are sourced from ConfigService (Firestore latest deployment first,
 * then environment-variable fallback).
 */
@ApiTags('Config')
@Controller('config')
export class ConfigController {
  constructor(private readonly configService: ConfigService) {}

  @Get('public')
  @ApiOperation({
    summary: 'Get public runtime config',
    description:
      'Returns the public runtime configuration needed by the frontend to connect to the ' +
      'correct Stellar network and Soroban contracts.\n\n' +
      'Values are loaded from Firestore (latest deployment record) with a fallback to environment variables. ' +
      'This endpoint is unauthenticated and safe to call from the browser.',
  })
  @ApiResponse({
    status: 200,
    description: 'Public runtime configuration',
    schema: {
      example: {
        network: 'testnet',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        heistContractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        zkVerifierContractId: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBSC4',
        vkHash: 'a3f2c1d4e5b60718293a4b5c6d7e8f9012345678901234567890abcdef012345',
      },
    },
  })
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
