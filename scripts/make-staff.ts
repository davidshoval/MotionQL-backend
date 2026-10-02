/** Grants (or with --revoke, removes) staff access: `npm run make-staff -- you@example.com`. */
import { connect } from '../src/db.js';

const args = process.argv.slice(2);
const revoke = args.includes('--revoke');
const email = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run make-staff -- you@example.com [--revoke]');
  process.exit(1);
}
const db = await connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017', process.env.MONGODB_DB ?? 'motionql');
const res = await db.c.users.updateOne({ email }, { $set: { isStaff: !revoke, updatedAt: new Date() } });
await db.c.auditEvents.insertOne({
  _id: `evt_cli_${Date.now()}`,
  at: new Date(),
  action: revoke ? 'staff.revoke' : 'staff.grant',
  target: { type: 'user', id: email, email },
  details: { via: 'make-staff script' },
});
console.log(res.matchedCount ? `${email} is ${revoke ? 'no longer' : 'now'} staff.` : `No account for ${email}. Register first.`);
await db.client.close();
