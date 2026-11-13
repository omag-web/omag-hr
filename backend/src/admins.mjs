// Managing who can sign in to the admin panel (the Cognito user pool).
// Locally (no USER_POOL_ID) a small in-memory list stands in for Cognito.

import {
  CognitoIdentityProviderClient, ListUsersCommand, AdminCreateUserCommand, AdminDeleteUserCommand,
  AdminDisableUserCommand, AdminEnableUserCommand, AdminGetUserCommand, AdminResetUserPasswordCommand
} from '@aws-sdk/client-cognito-identity-provider';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const pool = () => process.env.USER_POOL_ID;
let client;
const cognito = () => (client ||= new CognitoIdentityProviderClient({}));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ---------- local stand-in ---------- */
const local = new Map([['local-dev', { username: 'local-dev', email: 'local-dev', status: 'CONFIRMED', enabled: true, createdAt: new Date().toISOString() }]]);
export function _resetLocal() {
  for (const k of [...local.keys()]) if (k !== 'local-dev') local.delete(k);
}

const attr = (u, name) => (u.Attributes || u.UserAttributes || []).find((a) => a.Name === name)?.Value;
const fromCognito = (u) => ({
  username: u.Username,
  email: attr(u, 'email') || u.Username,
  status: u.UserStatus,
  enabled: u.Enabled !== false,
  createdAt: u.UserCreateDate ? new Date(u.UserCreateDate).toISOString() : null,
  updatedAt: u.UserLastModifiedDate ? new Date(u.UserLastModifiedDate).toISOString() : null
});

export async function listAdmins() {
  if (!pool()) return [...local.values()].map((u) => ({ ...u }));
  const out = [];
  let token;
  do {
    const r = await cognito().send(new ListUsersCommand({ UserPoolId: pool(), PaginationToken: token, Limit: 60 }));
    out.push(...r.Users.map(fromCognito));
    token = r.PaginationToken;
  } while (token);
  return out.sort((a, b) => a.email.localeCompare(b.email));
}

async function getAdmin(username) {
  if (!pool()) {
    const u = local.get(username);
    if (!u) throw err('That admin no longer exists.', 404);
    return u;
  }
  try {
    return fromCognito(await cognito().send(new AdminGetUserCommand({ UserPoolId: pool(), Username: username })));
  } catch (e) {
    if (e.name === 'UserNotFoundException') throw err('That admin no longer exists.', 404);
    throw e;
  }
}

/** Invite someone by email. Cognito emails them a temporary password. */
export async function inviteAdmin(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) throw err('Enter a valid email address.');
  const all = await listAdmins();
  if (all.some((u) => u.email.toLowerCase() === email)) throw err(`${email} is already an admin.`);
  if (!pool()) {
    const u = { username: `local-${local.size}`, email, status: 'FORCE_CHANGE_PASSWORD', enabled: true, createdAt: new Date().toISOString() };
    local.set(u.username, u);
    return u;
  }
  try {
    const r = await cognito().send(new AdminCreateUserCommand({
      UserPoolId: pool(),
      Username: email,
      UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
      DesiredDeliveryMediums: ['EMAIL']
    }));
    return fromCognito(r.User);
  } catch (e) {
    if (e.name === 'UsernameExistsException') throw err(`${email} is already an admin.`);
    if (e.name === 'InvalidParameterException') throw err('Cognito didn’t accept that email address.');
    throw e;
  }
}

/** Someone who hasn't signed in yet gets a fresh invite; someone who has gets a password-reset code. */
export async function resendAccess(username) {
  const u = await getAdmin(username);
  if (!u.enabled) throw err('Turn their access back on first.');
  if (u.status === 'FORCE_CHANGE_PASSWORD') {
    if (pool()) {
      await cognito().send(new AdminCreateUserCommand({ UserPoolId: pool(), Username: username, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] }));
    }
    return { message: `Sent ${u.email} a new invitation with a new temporary password (good for 7 days).` };
  }
  if (pool()) await cognito().send(new AdminResetUserPasswordCommand({ UserPoolId: pool(), Username: username }));
  else local.set(username, { ...u, status: 'RESET_REQUIRED' });
  return { message: `Emailed ${u.email} a code. They sign in with "Forgot password?" to choose a new password.` };
}

async function guard(username, me, verb) {
  const target = await getAdmin(username);
  if (target.email.toLowerCase() === String(me.email || '').toLowerCase() || target.username === me.username) {
    throw err(`You can’t ${verb} yourself. Ask another admin.`);
  }
  if (target.enabled) {
    const others = (await listAdmins()).filter((u) => u.enabled && u.username !== username);
    if (!others.length) throw err('Pip needs at least one admin with access.');
  }
  return target;
}

export async function setAdminEnabled(username, enabled, me) {
  const target = enabled ? await getAdmin(username) : await guard(username, me, 'turn off');
  if (!pool()) local.set(username, { ...target, enabled });
  else await cognito().send(new (enabled ? AdminEnableUserCommand : AdminDisableUserCommand)({ UserPoolId: pool(), Username: username }));
  forget(username);
  return { message: enabled ? `${target.email} can sign in again.` : `${target.email} can’t sign in any more. Turn it back on any time.` };
}

export async function removeAdmin(username, me) {
  const target = await guard(username, me, 'remove');
  if (!pool()) local.delete(username);
  else await cognito().send(new AdminDeleteUserCommand({ UserPoolId: pool(), Username: username }));
  forget(username);
  return { message: `Removed ${target.email}.` };
}

/* ---------- is a signed-in admin still allowed? (checked on every admin request, cached briefly) ---------- */
const active = new Map();
const TTL = 60_000;
function forget(username) { active.delete(username); }

/** True if the user still exists and is turned on. Turning someone off takes effect within a minute. */
export async function stillActive(username) {
  if (!pool() || !username) return true;
  const hit = active.get(username);
  if (hit && Date.now() - hit.at < TTL) return hit.ok;
  let ok;
  try { ok = (await getAdmin(username)).enabled; } catch (e) { if (e.status === 404) ok = false; else throw e; }
  active.set(username, { ok, at: Date.now() });
  return ok;
}
