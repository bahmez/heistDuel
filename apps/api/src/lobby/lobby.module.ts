import { Module } from '@nestjs/common';
import { LobbyController } from './lobby.controller';
import { LobbyService } from './lobby.service';
import { LobbyService as DbLobbyService } from '@repo/database';

/**
 * Feature module for all lobby and game-setup HTTP endpoints.
 *
 * Providers:
 *  - LobbyService        — application-layer orchestration (game setup, auth coordination)
 *  - DbLobbyService      — database-layer persistence via Firestore (from @repo/database)
 *  - StellarService      — injected globally from StellarModule
 *  - FirebaseService     — injected globally from FirebaseModule
 */
@Module({
  controllers: [LobbyController],
  providers: [LobbyService, DbLobbyService],
})
export class LobbyModule {}
