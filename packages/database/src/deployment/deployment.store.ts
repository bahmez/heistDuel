import type { FirebaseService } from '@repo/firebase';
import type { DeploymentRecord } from './deployment.model';

const COLLECTION = 'deployments';

/**
 * Firestore data-access layer for deployment records.
 * Contains only raw read/write operations — no business logic.
 */
export class DeploymentStore {
  constructor(private readonly firebase: FirebaseService) {}

  private get db() {
    return this.firebase.getFirestore();
  }

  /** Persist a new deployment record. The document ID is record.id. */
  async save(record: DeploymentRecord): Promise<void> {
    await this.db.collection(COLLECTION).doc(record.id).set(record);
  }

  /**
   * Return the most recent deployment for the given network.
   * Returns null if no deployment has ever been recorded.
   */
  async getLatest(network: string): Promise<DeploymentRecord | null> {
    const snap = await this.db
      .collection(COLLECTION)
      .where('network', '==', network)
      .orderBy('deployedAt', 'desc')
      .limit(1)
      .get();

    if (snap.empty) return null;
    return snap.docs[0]!.data() as DeploymentRecord;
  }

  /** Return all deployment records for the given network, newest first. */
  async list(network: string): Promise<DeploymentRecord[]> {
    const snap = await this.db
      .collection(COLLECTION)
      .where('network', '==', network)
      .orderBy('deployedAt', 'desc')
      .get();

    return snap.docs.map((d) => d.data() as DeploymentRecord);
  }
}
