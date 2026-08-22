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
  // Not enough ETH to cover the gas reimbursement the account owes the relayer.
  // (Value shortfalls are caught earlier by the affordability preflight.)
  CannotCoverGas: "Not enough ETH to cover the network fee. Add funds to this account and try again.",
  // A call inside the batch reverted. We can't always know why from on-chain data,
  // so keep the message generic; the raw name stays in the details disclosure.
  CallFailed: "This transaction couldn't complete. Nothing moved.",
  InitCallFailed: "This transaction couldn't complete. Nothing moved.",
  // Setup / auth reverts — shouldn't reach a normal user, but never show the name.
  AlreadyInitialized: "This account is already set up.",
  NotInitialized: "This account isn't set up yet.",
  InvalidInitSignature: "Couldn't verify the setup signature. Try again.",
  NotSelf: "This transaction couldn't complete.",
  NotOwner: "This transaction couldn't complete.",
  NotAriseModule: "This transaction couldn't complete.",
  // Legacy accounts still on the superseded guard fail closed on a large send to
  // an unverified address (the old guard required a code; there is no code now).
  // New accounts use the updated guard and never hit this.
  OtpRequired:
    "This account uses an older guard and can't send large amounts to unverified addresses. Create a new account to use the updated guard.",
  // No passkey linked to the active account on THIS device (e.g. an imported
  // account not yet linked). Never a dead-end: point to Accounts.
  "No passkey linked on this device":
    "No passkey is linked to this account on this device. Open Accounts to switch or create one.",
  // guardian-level (non-contract) errors that can reach the UI
  PasskeyRequired: "Confirm with your passkey to continue.",
  RateLimited: "Too many attempts. Wait a little and try again.",
  // onboarding failures — every one maps to a specific sentence; the raw error
  // only ever appears in the details disclosure.
  OnboardingPaused: "New account creation is paused — the service wallet needs a top-up. Try again shortly.",
  RelayerUnfunded: "New account creation is paused — the service wallet needs a top-up. Try again shortly.",
  OnboardingDailyCapReached: "The daily new-account limit was reached. Try again tomorrow.",
  PasskeyAlreadyOnboarded: "This passkey already has an account.",
  NetworkTimeout: "The network is slow right now. Try creating the account again.",
  OnboardingReverted: "Couldn't create the account — the setup transaction was rejected. Please try again.",
  OnboardingFailed: "Couldn't create the account. Please try again.",
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
  // Phase M: transaction-attached messages (memos + return requests).
  AnchorUnverified: "Couldn't confirm that transaction on-chain. Nothing was saved.",
  SenderNotVerified: "Only a verified account can request a return. Get verified first.",
  TokenNotAllowed: "Return requests are only for ETH right now.",
  AlreadyRequested: "You've already requested a return for this transfer.",
  ReminderTooSoon: "You can send one reminder, and only after a week.",
  MessageTooLong: "That note is too long. Shorten it and try again.",
  ReturnUnverified: "Couldn't confirm the return transaction on-chain.",
  ReturnTokenMismatch: "The return used a different token than the original transfer.",
  ReturnAmountMismatch: "The return amount didn't match the original transfer.",
  MessageFailed: "Couldn't save that just now. Try again.",
  InvalidRequest: "Something about that request wasn't right. Try again.",
  NotFound: "That message is no longer available.",
};

export function humanError(err: unknown): { text: string; raw: string } {
  const message = err instanceof Error ? err.message : String(err);
  // GuardianError carries the underlying network text on `.raw`; prefer it for
  // the disclosure so "TypeError: Failed to fetch" survives.
  const rawCarrier = (err as { raw?: string })?.raw;
  const raw = rawCarrier ?? message;
  // viem RPC errors bury the reason in `.details`/`.shortMessage` (e.g. a raw
  // "over rate limit" dump), not `.message`. Fold those into the search text so a
  // rate limit maps to its sentence instead of leaking the viem error to the UI.
  const viem = err as { details?: string; shortMessage?: string };
  const searchText = `${message} ${raw} ${viem?.details ?? ""} ${viem?.shortMessage ?? ""} ${String(err)}`;
  // Errors carrying a ready-made human sentence (e.g. InsufficientFundsError,
  // which needs the dynamic amount + address) surface it verbatim. The raw name
  // stays for the details disclosure.
  const human = (err as { human?: string })?.human;
  if (human) return { text: human, raw };
  if (isPasskeyUnavailable(err)) {
    return {
      text: "This device can't use a passkey. You need Windows Hello or another platform passkey.",
      raw,
    };
  }
  // A rate limit can arrive as -32016 without the literal words; catch both.
  if (/-32016|over rate limit|rate limit|too many request/i.test(searchText)) {
    return { text: SENTENCES["over rate limit"], raw };
  }
  const key = Object.keys(SENTENCES).find((k) => searchText.includes(k));
  return { text: key ? SENTENCES[key] : "Something went wrong. Try again.", raw };
}

const name = (err: unknown): string => (err as { name?: string })?.name ?? "";
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A canceled or timed-out passkey prompt. NOT an error: the user backed out.
 *  Only meaningful for prompts that target a KNOWN credential (sign/create),
 *  where NotAllowedError means cancel. In discovery (relink, no
 *  allowCredentials) NotAllowedError is ambiguous and handled separately. */
export function isUserCancel(err: unknown): boolean {
  return (
    name(err) === "NotAllowedError" ||
    /not allowed|timed out|operation either timed out/i.test(msg(err))
  );
}

/** The device has no usable authenticator (no Windows Hello, unsupported). */
export function isPasskeyUnavailable(err: unknown): boolean {
  return (
    name(err) === "NotSupportedError" ||
    /no available authenticator|not supported|InvalidStateError/i.test(msg(err))
  );
}
