import { sanitizeText } from '../../src/lib/sanitize';
import { randomToken } from './crypto';
import { HttpError } from './http';
import type { D1Database } from './types';

const now = () => Math.floor(Date.now() / 1000);
export const MAX_MEMBERS = 10;
const MAX_OWNED_TEAMS = 5;
const INVITE_SECONDS = 7 * 24 * 3600;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

type Role = 'owner' | 'editor' | 'viewer';
const isInviteRole = (r: unknown): r is 'editor' | 'viewer' => r === 'editor' || r === 'viewer';

async function membership(db: D1Database, userId: string, teamId: string): Promise<Role> {
  const m = await db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').bind(teamId, userId).first<{ role: Role }>();
  if (!m) throw new HttpError(404, 'Team not found.');
  return m.role;
}

async function requireOwner(db: D1Database, userId: string, teamId: string) {
  if ((await membership(db, userId, teamId)) !== 'owner') throw new HttpError(403, 'Only the team owner can do that.');
}

export async function createTeam(db: D1Database, user: { id: string; plan: string }, nameInput: unknown) {
  const name = typeof nameInput === 'string' ? sanitizeText(nameInput, 60) : '';
  if (!name) throw new HttpError(400, 'Give the team a name.');
  const owned = await db.prepare('SELECT COUNT(*) AS n FROM teams WHERE owner_id = ?').bind(user.id).first<{ n: number }>();
  if ((owned?.n ?? 0) >= MAX_OWNED_TEAMS) throw new HttpError(409, 'You have reached the team limit.');
  const id = crypto.randomUUID();
  const t = now();
  await db.prepare('INSERT INTO teams(id, name, owner_id, created_at) VALUES(?, ?, ?, ?)').bind(id, name, user.id, t).run();
  await db.prepare("INSERT INTO team_members(team_id, user_id, role, created_at) VALUES(?, ?, 'owner', ?)").bind(id, user.id, t).run();
  return { id, name, role: 'owner' as Role };
}

export async function listTeams(db: D1Database, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.name, m.role, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS members
       FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.user_id = ? ORDER BY t.created_at`,
    )
    .bind(userId)
    .all<{ id: string; name: string; role: Role; members: number }>();
  return results;
}

export async function getTeam(db: D1Database, userId: string, teamId: string) {
  const role = await membership(db, userId, teamId);
  const team = await db.prepare('SELECT id, name FROM teams WHERE id = ?').bind(teamId).first<{ id: string; name: string }>();
  const { results: members } = await db
    .prepare('SELECT u.id AS userId, u.email, m.role FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.created_at')
    .bind(teamId)
    .all<{ userId: string; email: string; role: Role }>();
  let invites: { token: string; email: string; role: string; expiresAt: number }[] = [];
  if (role === 'owner') {
    const { results } = await db
      .prepare('SELECT token, email, role, expires_at FROM team_invites WHERE team_id = ? AND expires_at > ? ORDER BY created_at')
      .bind(teamId, now())
      .all<{ token: string; email: string; role: string; expires_at: number }>();
    invites = results.map((i) => ({ token: i.token, email: i.email, role: i.role, expiresAt: i.expires_at }));
  }
  return { ...team!, role, members, invites };
}

export interface InviteMailer {
  inviterEmail: string;
  /** Public base URL of the app, e.g. https://motionforge.example.com. */
  appUrl: string | undefined;
  send: (mail: { to: string; subject: string; text: string }) => Promise<boolean>;
}

/**
 * Creates a single-use link and emails it when mail is configured. Either way the link is returned,
 * so the owner can also share it by hand.
 */
export async function inviteMember(db: D1Database, userId: string, teamId: string, emailInput: unknown, role: unknown, mailer?: InviteMailer) {
  await requireOwner(db, userId, teamId);
  const email = typeof emailInput === 'string' ? emailInput.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
  if (!isInviteRole(role)) throw new HttpError(400, 'Choose editor or viewer.');
  const count = await db.prepare('SELECT (SELECT COUNT(*) FROM team_members WHERE team_id = ?) + (SELECT COUNT(*) FROM team_invites WHERE team_id = ? AND expires_at > ? AND email <> ?) AS n')
    .bind(teamId, teamId, now(), email)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_MEMBERS) throw new HttpError(409, `Teams are limited to ${MAX_MEMBERS} people.`);
  await db.prepare('DELETE FROM team_invites WHERE team_id = ? AND email = ?').bind(teamId, email).run();
  const token = randomToken(24);
  await db
    .prepare('INSERT INTO team_invites(token, team_id, email, role, invited_by, created_at, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .bind(token, teamId, email, role, userId, now(), now() + INVITE_SECONDS)
    .run();
  let emailed = false;
  if (mailer?.appUrl) {
    const team = await db.prepare('SELECT name FROM teams WHERE id = ?').bind(teamId).first<{ name: string }>();
    const link = `${mailer.appUrl.replace(/\/$/, '')}/#/invite/${token}`;
    emailed = await mailer.send({
      to: email,
      subject: `${mailer.inviterEmail} invited you to ${team?.name ?? 'a team'} on MotionForge`,
      text:
        `${mailer.inviterEmail} invited you to join the team "${team?.name ?? ''}" on MotionForge as ${role === 'editor' ? 'an editor' : 'a viewer'}.\n\n` +
        `Open this link while signed in with this email address (${email}) to accept:\n${link}\n\n` +
        `The link expires in 7 days. If you were not expecting this, you can ignore this email.`,
    });
  }
  return { token, emailed };
}

export async function revokeInvite(db: D1Database, userId: string, teamId: string, token: string) {
  await requireOwner(db, userId, teamId);
  const r = await db.prepare('DELETE FROM team_invites WHERE token = ? AND team_id = ?').bind(token, teamId).run();
  if (!r.meta.changes) throw new HttpError(404, 'Invite not found.');
}

export async function previewInvite(db: D1Database, token: string) {
  const i = await db
    .prepare('SELECT i.email, i.role, t.name FROM team_invites i JOIN teams t ON t.id = i.team_id WHERE i.token = ? AND i.expires_at > ?')
    .bind(token, now())
    .first<{ email: string; role: string; name: string }>();
  if (!i) throw new HttpError(404, 'This invitation is no longer valid.');
  return { teamName: i.name, role: i.role };
}

export async function acceptInvite(db: D1Database, user: { id: string; email: string }, token: string) {
  const i = await db
    .prepare('SELECT team_id, email, role FROM team_invites WHERE token = ? AND expires_at > ?')
    .bind(token, now())
    .first<{ team_id: string; email: string; role: string }>();
  if (!i) throw new HttpError(404, 'This invitation is no longer valid.');
  if (i.email !== user.email.toLowerCase()) throw new HttpError(403, `This invitation was sent to a different email address.`);
  await db.prepare('INSERT OR IGNORE INTO team_members(team_id, user_id, role, created_at) VALUES(?, ?, ?, ?)').bind(i.team_id, user.id, i.role, now()).run();
  await db.prepare('DELETE FROM team_invites WHERE token = ?').bind(token).run();
  return { teamId: i.team_id };
}

export async function removeMember(db: D1Database, actorId: string, teamId: string, targetId: string) {
  const role = await membership(db, actorId, teamId);
  const target = await db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').bind(teamId, targetId).first<{ role: Role }>();
  if (!target) throw new HttpError(404, 'Member not found.');
  if (target.role === 'owner') throw new HttpError(409, 'The owner cannot be removed. Delete the team instead.');
  if (actorId !== targetId && role !== 'owner') throw new HttpError(403, 'Only the team owner can remove people.');
  await db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').bind(teamId, targetId).run();
}

export async function setMemberRole(db: D1Database, actorId: string, teamId: string, targetId: string, role: unknown) {
  await requireOwner(db, actorId, teamId);
  if (!isInviteRole(role)) throw new HttpError(400, 'Choose editor or viewer.');
  const r = await db.prepare("UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ? AND role <> 'owner'").bind(role, teamId, targetId).run();
  if (!r.meta.changes) throw new HttpError(404, 'Member not found.');
}

export async function deleteTeam(db: D1Database, actorId: string, teamId: string) {
  await requireOwner(db, actorId, teamId);
  await db.prepare('DELETE FROM teams WHERE id = ?').bind(teamId).run();
}

/** Used when creating or moving a project into a team. */
export async function requireTeamEditor(db: D1Database, userId: string, teamId: string) {
  const role = await membership(db, userId, teamId);
  if (role === 'viewer') throw new HttpError(403, 'Viewers cannot add projects to a team.');
}
