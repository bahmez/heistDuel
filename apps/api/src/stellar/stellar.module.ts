import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { StellarService } from './stellar.service';

/**
 * Global module exposing the StellarService.
 * Imports ConfigModule so ConfigService is available for injection into
 * StellarService, guaranteeing contract addresses are resolved from Firestore
 * before StellarService.onModuleInit() runs.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [StellarService],
  exports: [StellarService],
})
export class StellarModule {}
