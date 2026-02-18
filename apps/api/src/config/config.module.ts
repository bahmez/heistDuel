import { Module } from '@nestjs/common';
import { DeploymentService } from '@repo/database';
import { ConfigService } from './config.service';
import { ConfigController } from './config.controller';

/**
 * Provides runtime contract configuration sourced from Firestore deployments.
 * FirebaseModule must be imported globally before this module initialises.
 */
@Module({
  controllers: [ConfigController],
  providers: [
    // DeploymentService relies on FirebaseService from the global FirebaseModule.
    DeploymentService,
    ConfigService,
  ],
  exports: [ConfigService],
})
export class ConfigModule {}
