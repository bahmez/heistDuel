import { Module } from '@nestjs/common';
import { FirebaseModule } from '@repo/firebase';
import { LobbyModule } from './lobby/lobby.module';
import { StellarModule } from './stellar/stellar.module';

/**
 * Root application module.
 * Imports are ordered: infrastructure (Firebase, Stellar) → feature modules (Lobby).
 */
@Module({
  imports: [
    // Firebase Admin — global module, injected wherever needed
    FirebaseModule.forRoot({
      projectId: process.env.FIREBASE_PROJECT_ID,
      serviceAccountPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      useApplicationDefaultCredentials:
        process.env.FIREBASE_USE_ADC === 'true' ||
        !!process.env.K_SERVICE ||
        !!process.env.GOOGLE_CLOUD_PROJECT,
    }),

    // Stellar/Soroban RPC client — global module
    StellarModule,

    // Feature modules
    LobbyModule,
  ],
})
export class AppModule {}
