# Arise recovery

Arise recovers a lost device. You rotate to a new passkey with a single-use code. Your address and name stay the same. There is no seed phrase and no support ticket.

## The flow

Recovery happens on a fresh device with nothing loaded, so Arise starts by asking which account to recover. The screen is a step rail.

1. **Find account.** Enter the address or up.id of the account. Arise confirms it is a Suho account and that recovery email is enabled.
2. **New passkey.** Create a passkey on the new device.
3. **Request code.** A single-use recovery code is emailed to the account's registered recovery address. Nothing is shown on any page.
4. **Enter code and arise.** Enter the emailed code and tap Arise.

When it completes, the account's passkey is rotated. The old passkey stops working. The new one takes over.

The screen proves this on the spot. The old passkey fails with a clear message. The new passkey sends normally.

A full rotation is proven live. [View the arise transaction.](https://sepolia-explorer.giwa.io/tx/0x36770b1bc51c3b6972bb50b5b5d36b65e52121867fc8e1f90d4f254e85676bc3)

## Why it is safe

The recovery code commits to both the account and the hash of the new key. A code minted for one recovery cannot rotate in any other key or touch any other account.

Anyone may relay the recovery transaction. The authority is the code itself, not the caller. The lost-device user gets a code, a new passkey, and any relayer can submit. The code is single-use and consumed on chain the moment it verifies.

If the code expires while the input is open, the button becomes "Request a new code".
