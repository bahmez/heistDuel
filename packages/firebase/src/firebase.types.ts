export interface FirebaseModuleOptions {
  /** Firebase project ID. Required unless using Application Default Credentials. */
  projectId?: string;
  /** Service account client email for explicit credential. */
  clientEmail?: string;
  /** Service account private key for explicit credential. */
  privateKey?: string;
  /** Absolute path to a service account JSON file. */
  serviceAccountPath?: string;
  /** Environment variable that holds the path to a service account JSON file. */
  serviceAccountPathEnv?: string;
  /** Firebase Storage bucket. */
  storageBucket?: string;
  /** Firestore database ID (defaults to "(default)"). */
  databaseId?: string;
  /** Optional app name for multi-app setups. */
  appName?: string;
  /** Use Application Default Credentials (recommended on GCP/Cloud Run). */
  useApplicationDefaultCredentials?: boolean;
}
