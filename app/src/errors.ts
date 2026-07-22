/// Single source of truth for turning raw errors into sentences in the
/// interface's voice (design copy rules). The toast and every inline error
/// render share this so the app never leaks "TypeError: Failed to fetch" or a
/// bare revert name at a user. The original text is always preserved as `raw`
/// for a "details" disclosure.

const SENTENCES: Record<string, string> = {
  // connection / network (Phase T item 2)
  "Failed to fetch": "Can't reach the guardian service. Check that it's running.",
  NetworkError: "Can't reach the guardian service. Check that it's running.",
  "guardian unreachable": "Can't reach the guardian service. Check that it's running.",
  "Load failed": "Can't reach the guardian service. Check that it's running.",
  "over rate limit": "GIWA is rate limiting right now. Wait a moment and try again.",
  // on-chain / guard / attester reverts
  TransactionReverted: "The transaction reverted on-chain. Nothing moved.",
  CodeInvalid: "That code didn't match. Check the verification service.",
  CodeExpired: "Code expired. Request a fresh one.",
  CodeAlreadyUsed: "That code was already used. Request a fresh one.",
  CodeNotFound: "No active code for this action. Request a new one.",
  InvalidPasskeySignature: "This passkey can't sign for the account.",
  // guardian flow errors (verify-me / claim-name)
  AlreadyVerified: "This account is already verified.",
  AlreadyNamed: "This account already has a name.",
  NameTaken: "That name is taken. Try another.",
  InvalidLabel: "Names use a to z, 0 to 9, and a dash. Minimum 3 characters.",
};

export function humanError(err: unknown): { text: string; raw: string } {
  const message = err instanceof Error ? err.message : String(err);
  // GuardianError carries the underlying network text on `.raw`; prefer it for
  // the disclosure so "TypeError: Failed to fetch" survives.
  const rawCarrier = (err as { raw?: string })?.raw;
  const raw = rawCarrier ?? message;
  const key = Object.keys(SENTENCES).find((k) => message.includes(k) || raw.includes(k));
  return { text: key ? SENTENCES[key] : "Something went wrong. Try again.", raw };
}
