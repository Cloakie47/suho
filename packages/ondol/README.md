# @suho/ondol

Add **Suho** — a passkey wallet on GIWA — as your dApp's wallet in a few lines. Your users sign in and sign messages with one Windows Hello / Touch ID tap, in a Suho-origin popup. First-time users onboard right inside that popup (gasless), so Suho's onboarding becomes yours.

- EIP-1193-style provider: `eth_requestAccounts`, `eth_accounts`, `eth_chainId`, `personal_sign`, `eth_signTypedData_v4`.
- One backend function to verify a sign-in on-chain via ERC-1271.
- Zero heavy dependencies. ESM + types.

> GIWA Sepolia (chain id 91342) only for now. `eth_sendTransaction` arrives in the next stage.

## Install

```sh
npm i @suho/ondol
```

## Sign in with Suho (10 lines)

```ts
import { createOndolProvider } from "@suho/ondol";

const suho = createOndolProvider(); // { appUrl } to override the Suho app URL

// Connect: opens the Suho popup, returns the account address.
const [address] = (await suho.request({ method: "eth_requestAccounts" })) as string[];

// Sign a SIWE / plain message: one passkey tap, returns an ERC-1271 signature.
const message = `example.com wants you to sign in with your Ethereum account:\n${address}\n\nNonce: abc123`;
const signature = (await suho.request({ method: "personal_sign", params: [message, address] })) as string;
```

## Verify on your backend

The signature is an ERC-1271 signature by the account contract. Verify it on-chain with one call — no wallet libraries:

```ts
import { verifyOndolSignature } from "@suho/ondol";
import { hashMessage } from "viem"; // or any EIP-191 hasher

const hash = hashMessage(message); // the exact digest that was signed
const ok = await verifyOndolSignature(hash, signature, address, "https://sepolia-rpc.giwa.io");
if (!ok) throw new Error("Invalid Suho sign-in");
```

`hash` must be the exact 32-byte digest that was signed (EIP-191 for `personal_sign`, EIP-712 for typed data). Binding the message to intent — domain, nonce, expiry — is the message format's job (SIWE does this); ERC-1271 only attests that the account's current passkey signed this hash. Because it reads the live passkey, a rotated (recovered) key stops validating old signatures automatically.

## Typed data

```ts
const signature = await suho.request({
  method: "eth_signTypedData_v4",
  params: [address, JSON.stringify(typedData)],
});
// verify with hashTypedData(typedData) as the hash
```

## Notes

- The popup only trusts messages from the page that opened it, and the origin it displays comes from the browser (`MessageEvent.origin`), never from the message body.
- One passkey tap per approval. Closing the popup rejects the pending request; requests time out after two minutes.
- Connections are remembered per-origin on the Suho side and are revocable by the user from Suho's Protection screen.
