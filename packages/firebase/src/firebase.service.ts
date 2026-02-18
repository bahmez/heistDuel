import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import * as admin from 'firebase-admin';
import type { FirebaseModuleOptions } from './firebase.types';
import { FIREBASE_OPTIONS } from './firebase.constants';

/**
 * Core Firebase service.
 * Initializes Firebase Admin SDK and exposes getFirestore() for other services.
 */
@Injectable()
export class FirebaseService implements OnModuleDestroy {
  private readonly logger = new Logger(FirebaseService.name);
  private readonly app: admin.app.App;

  constructor(
    @Inject(FIREBASE_OPTIONS) private readonly options: FirebaseModuleOptions,
  ) {
    this.app = this.initializeApp(options);
    this.logger.log(
      `Firebase initialized — project: ${options.projectId ?? 'default'}, app: ${options.appName ?? '[DEFAULT]'}`,
    );
  }

  private initializeApp(options: FirebaseModuleOptions): admin.app.App {
    const defaultAppName = '[DEFAULT]';
    const appName = options.appName ?? (admin.apps.length === 0 ? defaultAppName : `heist-${Date.now()}`);

    // Avoid duplicate initialization during hot-reloads
    const existingApp = admin.apps.find((a) => a?.name === appName);
    if (existingApp) {
      this.logger.warn(`Firebase app "${appName}" already exists — reusing it`);
      return existingApp;
    }

    let credential: admin.credential.Credential;

    // Cloud Run (and GCP in general) exposes Application Default Credentials.
    // We prefer explicit credentials when they are valid, but gracefully fall
    // back to ADC if a service-account path is missing/invalid.
    const useAdcByDefault =
      options.useApplicationDefaultCredentials ||
      !!process.env.K_SERVICE ||
      !!process.env.GOOGLE_CLOUD_PROJECT ||
      !!process.env.GCLOUD_PROJECT;

    if (options.serviceAccountPath) {
      try {
        credential = admin.credential.cert(options.serviceAccountPath);
      } catch (err) {
        if (!useAdcByDefault) {
          throw err;
        }
        this.logger.warn(
          `Invalid serviceAccountPath "${options.serviceAccountPath}". ` +
            `Falling back to Application Default Credentials (Cloud Run/GCP). Reason: ${err}`,
        );
        credential = admin.credential.applicationDefault();
      }
    } else if (options.serviceAccountPathEnv) {
      const path = process.env[options.serviceAccountPathEnv];
      if (path) {
        try {
          credential = admin.credential.cert(path);
        } catch (err) {
          if (!useAdcByDefault) {
            throw err;
          }
          this.logger.warn(
            `Invalid path from env "${options.serviceAccountPathEnv}" (${path}). ` +
              `Falling back to Application Default Credentials. Reason: ${err}`,
          );
          credential = admin.credential.applicationDefault();
        }
      } else if (useAdcByDefault) {
        this.logger.log(
          `Env "${options.serviceAccountPathEnv}" is not set — using Application Default Credentials.`,
        );
        credential = admin.credential.applicationDefault();
      } else {
        throw new Error(
          `Environment variable "${options.serviceAccountPathEnv}" is not set`,
        );
      }
    } else if (options.clientEmail && options.privateKey) {
      credential = admin.credential.cert({
        projectId: options.projectId,
        clientEmail: options.clientEmail,
        privateKey: options.privateKey,
      });
    } else if (useAdcByDefault) {
      credential = admin.credential.applicationDefault();
    } else {
      throw new Error(
        'FirebaseModule: no credentials provided. ' +
          'Set useApplicationDefaultCredentials, serviceAccountPath, or clientEmail+privateKey.',
      );
    }

    const appOptions: admin.AppOptions = {
      credential,
      storageBucket: options.storageBucket,
    };

    if (options.projectId) {
      appOptions.projectId = options.projectId;
    }

    return admin.initializeApp(appOptions, appName);
  }

  /** Returns the Firestore instance for this Firebase app. */
  getFirestore(): admin.firestore.Firestore {
    return this.app.firestore();
  }

  /** Returns the raw Firebase Admin app instance. */
  getApp(): admin.app.App {
    return this.app;
  }

  onModuleDestroy(): void {
    // Apps are long-lived — do not delete them on module destroy
    // to avoid issues with hot-reload in development.
  }
}
