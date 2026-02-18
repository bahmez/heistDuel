import { Module, type DynamicModule } from '@nestjs/common';
import { FirebaseService } from './firebase.service';
import { FIREBASE_OPTIONS } from './firebase.constants';
import type { FirebaseModuleOptions } from './firebase.types';

/**
 * Dynamic NestJS module that bootstraps Firebase Admin SDK.
 *
 * Usage in AppModule:
 * ```ts
 * FirebaseModule.forRoot({
 *   projectId: process.env.FIREBASE_PROJECT_ID,
 *   serviceAccountPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
 * })
 * ```
 */
@Module({})
export class FirebaseModule {
  static forRoot(options: FirebaseModuleOptions): DynamicModule {
    return {
      module: FirebaseModule,
      global: true,
      providers: [
        { provide: FIREBASE_OPTIONS, useValue: options },
        FirebaseService,
      ],
      exports: [FirebaseService],
    };
  }
}
