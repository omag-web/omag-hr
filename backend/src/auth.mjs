// Admin authentication: verifies the Cognito ID token sent as "Authorization: Bearer <token>".
// Locally (no USER_POOL_ID, not running in Lambda) admin routes are open so the dev
// server can be used without Cognito. In Lambda, a missing pool always means "deny".

import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { stillActive } from './admins.mjs';

let verifier;
const unauthorized = (msg = 'Please sign in.') => Object.assign(new Error(msg), { status: 401 });

export async function requireAdmin(event) {
  const pool = process.env.USER_POOL_ID;
  const client = process.env.USER_POOL_CLIENT_ID;
  if (!pool || !client) {
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) throw unauthorized('Admin sign-in is not configured.');
    return { email: 'local-dev', username: 'local-dev', dev: true };
  }
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw unauthorized();
  verifier ||= CognitoJwtVerifier.create({ userPoolId: pool, clientId: client, tokenUse: 'id' });
  let claims;
  try {
    claims = await verifier.verify(token);
  } catch {
    throw unauthorized('Your session expired. Please sign in again.');
  }
  const username = claims['cognito:username'];
  // Someone removed or turned off in the Admins page loses access within a minute, even mid-session.
  if (!(await stillActive(username))) throw unauthorized('Your admin access was turned off. Ask another admin if you need it back.');
  return { email: claims.email || username, username };
}

export function authConfig() {
  return {
    region: process.env.AWS_REGION || 'us-east-1',
    userPoolId: process.env.USER_POOL_ID || null,
    clientId: process.env.USER_POOL_CLIENT_ID || null,
    local: !process.env.USER_POOL_ID
  };
}
