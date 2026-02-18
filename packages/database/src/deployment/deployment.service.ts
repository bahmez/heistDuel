import { Injectable, Inject } from '@nestjs/common';
import { FirebaseService } from '@repo/firebase';
import { DeploymentStore } from './deployment.store';
import type { DeploymentRecord } from './deployment.model';

/**
 * NestJS injectable service for deployment record persistence.
 * Wraps DeploymentStore with higher-level operations.
 */
@Injectable()
export class DeploymentService {
  private readonly store: DeploymentStore;

  constructor(@Inject(FirebaseService) firebase: FirebaseService) {
    this.store = new DeploymentStore(firebase);
  }

  /** Persist a new deployment record to Firestore. */
  async save(record: DeploymentRecord): Promise<void> {
    return this.store.save(record);
  }

  /**
   * Return the most recent deployment record for the given network.
   * Returns null when no deployment has been recorded yet.
   */
  async getLatest(network: string): Promise<DeploymentRecord | null> {
    return this.store.getLatest(network);
  }

  /** Return all deployment records for the given network, newest first. */
  async list(network: string): Promise<DeploymentRecord[]> {
    return this.store.list(network);
  }
}
