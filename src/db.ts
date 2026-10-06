import { MongoClient } from 'mongodb';
import type { Collection, Db } from 'mongodb';
import type { LicenseEdition, LicensePayload, ManifestNotification, RequiredUpdateRule } from './licensing/types.js';

export type TeamRole = 'owner' | 'admin' | 'member';
export type LicenseSource = 'free' | 'team' | 'staff';

export interface UserDoc {
  _id: string;
  /** Lower-cased; unique. */
  email: string;
  name: string;
  company?: string;
  passwordHash: string;
  emailVerifiedAt?: Date;
  isStaff: boolean;
  /** The code in the user's invite link (motionql.com/r/CODE). Upper-case; unique. Older accounts get one on first use. */
  referralCode?: string;
  /** The user whose invite link this account signed up with. */
  referredBy?: string;
  /** Answer to "How did you hear about us?" at sign-up. */
  heardFrom?: string;
  /** Set on the invited user once the referral reward went to both people, so it is paid once. */
  referralRewardedAt?: Date;
  /** Referral reward days waiting for the user's next free key (they had no active free key when earned). */
  bonusDays?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionDoc {
  /** sha256 of the cookie token; the token itself is never stored. */
  _id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export type EmailTokenPurpose = 'verify-email' | 'password-reset';

export interface EmailTokenDoc {
  /** sha256 of the token sent by e-mail. */
  _id: string;
  purpose: EmailTokenPurpose;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface TeamDoc {
  _id: string;
  name: string;
  ownerId: string;
  /** Seats the team may hand out (staff-set while seats are free; from the subscription once billing starts). */
  seatLimit: number;
  /** Kept exact with conditional updates: assigning a seat only succeeds while seatsUsed < seatLimit. */
  seatsUsed: number;
  /** Editions and extra features admins may give members (staff-set; billing will set them later). */
  allowedEditions: LicenseEdition[];
  allowedFeatures: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamMemberDoc {
  _id: string;
  teamId: string;
  userId: string;
  role: TeamRole;
  hasSeat: boolean;
  /** The member's current team key while they hold a seat. */
  licenseId?: string;
  edition: LicenseEdition;
  features: string[];
  joinedAt: Date;
}

export interface InviteDoc {
  _id: string;
  teamId: string;
  email: string;
  role: Exclude<TeamRole, 'owner'>;
  assignSeat: boolean;
  /** sha256 of the token in the invite link. */
  tokenHash: string;
  invitedBy: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface LicenseDoc {
  /** The licenseId inside the signed payload. */
  _id: string;
  userId?: string;
  teamId?: string;
  source: LicenseSource;
  /** The full MQL1 key; Ed25519 is deterministic, so this is exactly what signing the payload gives again. */
  key: string;
  payload: LicensePayload;
  /** sha256("motionql-license-id:" + licenseId): what the app sends in its ping and the manifest lists when revoked. */
  hash: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  revokeReason?: string;
  /** Set when this key was reissued; the new key's id. */
  replacedBy?: string;
  issuedBy?: string;
}

/** Settings the owner changes in the staff console. */
export interface FreePlanSettings {
  _id: 'free';
  /** Every verified user gets a key while this is on. */
  enabled: boolean;
  edition: LicenseEdition;
  features: string[];
  durationDays: number;
  /** Users can get a fresh key from /account when theirs is about to run out. */
  renewable: boolean;
  /** How many days before expiry renewal opens. */
  renewWindowDays: number;
  updatedAt?: Date;
  updatedBy?: string;
}

export interface TeamPlanSettings {
  _id: 'team';
  /** Seat limit for new teams. */
  defaultSeatLimit: number;
  edition: LicenseEdition;
  durationDays: number;
  updatedAt?: Date;
  updatedBy?: string;
}

/** Refer a friend: both people get extra days on their free key when the invited user confirms their e-mail. */
export interface ReferralSettings {
  _id: 'referral';
  /** Off by default: links and counts always work, the reward only while this is on. */
  enabled: boolean;
  /** Days added for the inviter and for the friend. */
  bonusDays: number;
  /** Most rewards one inviter can earn. */
  maxRewardsPerUser: number;
  updatedAt?: Date;
  updatedBy?: string;
}

export type PlanDoc = FreePlanSettings | TeamPlanSettings | ReferralSettings;

export interface ManifestDoc {
  _id: 'current';
  requiredUpdate?: { stable?: RequiredUpdateRule; beta?: RequiredUpdateRule };
  notifications: ManifestNotification[];
  /** Unset means on. Every released app (1.0.0 on) reads `revokedLicenses`; only pre-release builds refuse it. */
  includeRevocations?: boolean;
  /** Last signed token, re-signed when the content or the revocation list changes. */
  token?: string;
  issuedAt?: Date;
  /** sha256 of what was signed (content + revocation list), to know when to re-sign. */
  signedDigest?: string;
  updatedAt: Date;
  updatedBy?: string;
}

export interface InstallDoc {
  _id: string;
  firstSeen: Date;
  lastSeen: Date;
  appVersion: string;
  channel: string;
  platform: string;
  arch: string;
  edition: string;
  licenseHash?: string;
}

export type FeedbackKind = 'bug' | 'idea' | 'praise' | 'other';
export type FeedbackStatus = 'new' | 'read' | 'done';

/** A message sent from the website's feedback form or the app's Help > Send feedback. */
export interface FeedbackDoc {
  _id: string;
  kind: FeedbackKind;
  message: string;
  source: 'website' | 'app';
  /** Where to reply; the signed-in user's address when they left it empty. */
  email?: string;
  userId?: string;
  /** Website: the page the form was opened from. */
  page?: string;
  /** App: what it runs on, to reproduce a bug. */
  app?: { version: string; platform: string; arch: string; channel?: string; edition?: string };
  status: FeedbackStatus;
  createdAt: Date;
  updatedAt?: Date;
  updatedBy?: string;
}

export interface AuditEventDoc {
  _id: string;
  at: Date;
  actorId?: string;
  actorEmail?: string;
  teamId?: string;
  action: string;
  target?: { type: 'user' | 'team' | 'license' | 'invite' | 'settings' | 'manifest' | 'feedback'; id: string; email?: string };
  details?: Record<string, unknown>;
}

export interface Collections {
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  emailTokens: Collection<EmailTokenDoc>;
  teams: Collection<TeamDoc>;
  teamMembers: Collection<TeamMemberDoc>;
  invites: Collection<InviteDoc>;
  licenses: Collection<LicenseDoc>;
  plans: Collection<PlanDoc>;
  manifest: Collection<ManifestDoc>;
  installs: Collection<InstallDoc>;
  auditEvents: Collection<AuditEventDoc>;
  feedback: Collection<FeedbackDoc>;
}

/** Privacy policy: an install record is deleted 25 months after it was last seen (docs/PRODUCT_SERVICE.md). */
export const INSTALL_RETENTION_SECONDS = 25 * 31 * 24 * 60 * 60;

export function collections(db: Db): Collections {
  return {
    users: db.collection('users'),
    sessions: db.collection('sessions'),
    emailTokens: db.collection('emailTokens'),
    teams: db.collection('teams'),
    teamMembers: db.collection('teamMembers'),
    invites: db.collection('invites'),
    licenses: db.collection('licenses'),
    plans: db.collection('plans'),
    manifest: db.collection('manifest'),
    installs: db.collection('installs'),
    auditEvents: db.collection('auditEvents'),
    feedback: db.collection('feedback'),
  };
}

export async function ensureIndexes(c: Collections): Promise<void> {
  await Promise.all([
    c.users.createIndex({ email: 1 }, { unique: true }),
    c.users.createIndex({ referralCode: 1 }, { unique: true, partialFilterExpression: { referralCode: { $type: 'string' } } }),
    c.users.createIndex({ referredBy: 1 }, { partialFilterExpression: { referredBy: { $type: 'string' } } }),
    c.sessions.createIndex({ userId: 1 }),
    c.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.emailTokens.createIndex({ userId: 1, purpose: 1 }),
    c.emailTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.teamMembers.createIndex({ teamId: 1, userId: 1 }, { unique: true }),
    c.teamMembers.createIndex({ userId: 1 }),
    c.invites.createIndex({ tokenHash: 1 }, { unique: true }),
    c.invites.createIndex({ teamId: 1, email: 1 }, { unique: true }),
    c.invites.createIndex({ email: 1 }),
    c.invites.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.licenses.createIndex({ userId: 1, issuedAt: -1 }),
    c.licenses.createIndex({ teamId: 1 }),
    c.licenses.createIndex({ hash: 1 }),
    c.licenses.createIndex({ 'payload.email': 1 }),
    c.licenses.createIndex({ revokedAt: 1, expiresAt: 1 }, { partialFilterExpression: { revokedAt: { $exists: true } } }),
    c.installs.createIndex({ lastSeen: 1 }, { expireAfterSeconds: INSTALL_RETENTION_SECONDS }),
    c.installs.createIndex({ licenseHash: 1 }),
    c.auditEvents.createIndex({ teamId: 1, at: -1 }),
    c.auditEvents.createIndex({ at: -1 }),
    c.teams.createIndex({ name: 1 }),
    c.feedback.createIndex({ status: 1, _id: -1 }),
  ]);
  // Revocations used to default to off. Clear that stored default (never touched by staff) so the new default, on, applies.
  await c.manifest.updateOne({ _id: 'current', includeRevocations: false, updatedBy: { $exists: false } }, { $unset: { includeRevocations: '' } });
}

export interface Database {
  client: MongoClient;
  db: Db;
  c: Collections;
}

export async function connect(uri: string, dbName: string): Promise<Database> {
  const client = new MongoClient(uri, { appName: 'motionql-backend' });
  await client.connect();
  const db = client.db(dbName);
  const c = collections(db);
  await ensureIndexes(c);
  return { client, db, c };
}
