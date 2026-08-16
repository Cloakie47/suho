import "./env.js";

/// Phase H email delivery via Resend. The only channel that ever carries a
/// recovery code. Sender + key from env; on the testnet issuer the Resend shared
/// sender is acceptable (documented). Codes are never logged here.

const RESEND_URL = "https://api.resend.com/emails";

async function send(body: { to: string; subject: string; text: string }): Promise<string> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  const from = process.env.SUHO_EMAIL_FROM;
  if (!from) throw new Error("SUHO_EMAIL_FROM is not set");
  const r = await fetch(RESEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, ...body }),
  });
  const j = (await r.json()) as { id?: string; message?: string };
  if (!r.ok || !j.id) throw new Error(`resend ${r.status}: ${j.message ?? JSON.stringify(j)}`);
  return j.id;
}

export function sendConfirmationCode(to: string, code: string): Promise<string> {
  return send({
    to,
    subject: "Confirm your Suho recovery email",
    text:
      `Your Suho confirmation code is ${code}.\n\n` +
      `Entering it confirms this address as the recovery channel for your Suho account. ` +
      `The code expires in 10 minutes.\n\n` +
      `If you did not request this, ignore this email and nothing changes.`,
  });
}

export function sendAriseCode(to: string, code: string, account: string, expiresInMin: number): Promise<string> {
  return send({
    to,
    subject: "Your Suho recovery code",
    text:
      `Your Suho recovery code is ${code}.\n\n` +
      `It authorizes rotating your Suho account\n${account}\nto a new passkey. ` +
      `It expires in ${expiresInMin} minutes and can be used once.\n\n` +
      `If you did not request this, ignore this email and your account is unchanged.`,
  });
}

/// Phase SEC 2.3: the second-factor code for a locked sensitive op (setGuard /
/// upgrade / disabling a lock) or a large send. `what` is a short human phrase.
export function sendOpCode(to: string, code: string, what: string, account: string): Promise<string> {
  return send({
    to,
    subject: "Your Suho security code",
    text:
      `Your Suho security code is ${code}.\n\n` +
      `It authorizes: ${what}\nfor your Suho account\n${account}\n` +
      `It expires in 10 minutes and can be used once.\n\n` +
      `If you did not request this, ignore this email. Your account is unchanged, ` +
      `and whoever asked has your passkey but not this code, so nothing happens without it.`,
  });
}

/// G3: on a LOCKED account, changing the recovery email requires a code sent to
/// the CURRENT (old) address, so a passkey-only attacker cannot rotate the
/// recovery channel to their own inbox.
export function sendRecoveryChangeAuthCode(to: string, code: string): Promise<string> {
  return send({
    to,
    subject: "Authorize changing your Suho recovery email",
    text:
      `Your Suho security code is ${code}.\n\n` +
      `Someone asked to change the recovery email on your account to a different address. ` +
      `Because extra protection is on, this change needs a code sent to your current recovery email (this one).\n\n` +
      `Enter it only if YOU are changing your recovery email. If you did not ask for this, ` +
      `do nothing: the change cannot proceed without this code, so your recovery channel stays as it is.`,
  });
}

export function sendEmailChangeNotice(to: string): Promise<string> {
  return send({
    to,
    subject: "Your Suho recovery email was changed",
    text:
      `The recovery email for your Suho account was just changed to a different address.\n\n` +
      `If this was you, no action is needed. If it was not, act now — whoever changed it is present with your passkey.`,
  });
}
