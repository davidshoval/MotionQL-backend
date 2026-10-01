/**
 * Types copied from the desktop app (Xquery.io-Platform src/shared/license.ts and src/shared/product.ts,
 * commit 7a1d096). Keep them in sync: the app verifies exactly these shapes.
 */
export type LicenseEdition = 'trial' | 'pro' | 'enterprise';

export const EDITIONS: readonly LicenseEdition[] = ['trial', 'pro', 'enterprise'];

/** Features that need a license. `pro` includes migration, masking, tasks and atlas; `team` needs enterprise or features: ["team"]. */
export const PRO_FEATURE_IDS = ['team', 'migration', 'masking', 'tasks', 'atlas'] as const;
export type ProFeature = (typeof PRO_FEATURE_IDS)[number];

/** The signed part of a license key. */
export interface LicensePayload {
  licenseId: string;
  customer: string;
  email: string;
  edition: LicenseEdition;
  seats: number;
  /** ISO 8601. */
  issuedAt: string;
  /** ISO 8601. */
  expiresAt: string;
  /** Extra features on top of the edition's defaults. Always present, even when empty. */
  features: string[];
}

export type NotificationSeverity = 'info' | 'warning' | 'critical';
export type NotificationCategory = 'news' | 'security' | 'update' | 'license';

export interface NotificationTarget {
  minVersion?: string;
  maxVersion?: string;
  editions?: (LicenseEdition | 'free')[];
  platforms?: ('darwin' | 'win32' | 'linux')[];
  channels?: ('stable' | 'beta')[];
}

export interface ManifestNotification {
  id: string;
  severity: NotificationSeverity;
  category?: NotificationCategory;
  title: string;
  body: string;
  url?: string;
  urlLabel?: string;
  publishedAt: string;
  expiresAt?: string;
  target?: NotificationTarget;
}

export interface RequiredUpdateRule {
  minimumVersion: string;
  blockAfter?: string;
  message?: string;
  downloadUrl?: string;
}

/** The signed body of the manifest. */
export interface ProductManifest {
  schema: 1;
  issuedAt: string;
  requiredUpdate?: { stable?: RequiredUpdateRule; beta?: RequiredUpdateRule };
  notifications: ManifestNotification[];
  /**
   * sha256("xquery-license-id:" + licenseId) of revoked, unexpired keys, lowercase hex; omitted when empty. Apps
   * before Platform PR #51 refuse a manifest carrying it, so it is only sent when `includeRevocations` is on.
   */
  revokedLicenses?: string[];
}

/** Exactly what the usage ping sends. */
export interface UsagePing {
  installId: string;
  appVersion: string;
  channel: 'stable' | 'beta';
  platform: string;
  arch: string;
  edition: LicenseEdition | 'free';
  licenseHash?: string;
}
