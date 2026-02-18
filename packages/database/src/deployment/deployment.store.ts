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
    let indexedQueryError: unknown = null;

    // Preferred path. May require a composite index in some Firestore setups.
    try {
      const indexed = await this.db
        .collection(COLLECTION)
        .where('network', '==', network)
        .orderBy('deployedAt', 'desc')
        .limit(1)
        .get();

      if (!indexed.empty) return indexed.docs[0]!.data() as DeploymentRecord;
    } catch (err) {
      indexedQueryError = err;
      // Keep the raw Firestore message (often includes the direct index URL).
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[DeploymentStore] Indexed getLatest query failed for network="${network}". ` +
          `Falling back to non-index query. Firestore message: ${msg}`,
      );
    }

    // Fallback path that does not require a composite index:
    // fetch a bounded set then sort/filter in memory.
    const snap = await this.db.collection(COLLECTION).limit(200).get();
    if (snap.empty) return null;

    const wanted = network.trim().toLowerCase();
    const rows = snap.docs.map((d) => d.data() as Record<string, unknown>);

    const ranked = rows
      .sort((a, b) => {
        const ad = String((a.deployedAt ?? a.id ?? '') as string);
        const bd = String((b.deployedAt ?? b.id ?? '') as string);
        return bd.localeCompare(ad);
      });

    const byNetwork = ranked.find((r) => {
      const n = String((r.network ?? '') as string).trim().toLowerCase();
      return n === wanted;
    });

    if (byNetwork) return byNetwork as DeploymentRecord;

    // Last resort: return the most recent deployment regardless of network.
    if (ranked.length > 0) return ranked[0] as DeploymentRecord;

    // If we had an indexed-query failure and no fallback data, bubble up with
    // full error context so Cloud Run logs expose the Firestore index URL.
    if (indexedQueryError) {
      throw indexedQueryError;
    }
    return null;
  }

  /** Return all deployment records for the given network, newest first. */
  async list(network: string): Promise<DeploymentRecord[]> {
    try {
      const snap = await this.db
        .collection(COLLECTION)
        .where('network', '==', network)
        .orderBy('deployedAt', 'desc')
        .get();
      return snap.docs.map((d) => d.data() as DeploymentRecord);
    } catch {
      const wanted = network.trim().toLowerCase();
      const snap = await this.db.collection(COLLECTION).limit(500).get();
      return snap.docs
        .map((d) => d.data() as Record<string, unknown>)
        .filter((r) => String((r.network ?? '') as string).trim().toLowerCase() === wanted)
        .sort((a, b) =>
          String((b.deployedAt ?? b.id ?? '') as string).localeCompare(
            String((a.deployedAt ?? a.id ?? '') as string),
          ),
        ) as DeploymentRecord[];
    }
  }
}
