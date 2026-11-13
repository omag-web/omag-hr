// Admin authentication: verifies the Cognito ID token sent as "Authorization: Bearer <token>".
// Locally (no USER_POOL_ID, not running in Lambda) admin routes are open so the dev
// server can be used without Cognito. In Lambda, a missing pool always means "deny".

import { CognitoJwtVerifier } from 'aws-jwt-verify';

let verifier;
const unauthorized = (msg = 'Please sign in.') => Object.assign(new Error(msg), { status: 401 });

export async function requireAdmin(event) {
  const pool = process.env.USER_POOL_ID;
  const client = process.env.USER_POOL_CLIENT_ID;
  if (!pool || !client) {
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) throw unauthorized('Admin sign-in is not configured.');
    return { email: 'local-dev', dev: true };
  }
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw unauthorized();
  verifier ||= CognitoJwtVerifier.create({ userPoolId: pool, clientId: client, tokenUse: 'id' });
  try {
    const claims = await verifier.verify(token);
    return { email: claims.email || claims['cognito:username'] };
  } catch {
    throw unauthorized('Your session expired. Please sign in again.');
  }
}

export function authConfig() {
  return {
    region: process.env.AWS_REGION || 'us-east-1',
    userPoolId: process.env.USER_POOL_ID || null,
    clientId: process.env.USER_POOL_CLIENT_ID || null,
    local: !process.env.USER_POOL_ID
  };
}
