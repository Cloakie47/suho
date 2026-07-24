# Costs and limits

Suho runs a relayer so users never need gas to start. This page says who pays for what, how the reimbursement model keeps that honest, and where the limits are.

## Who pays for what

- **Onboarding is sponsored.** Creating an account is one relayer-paid transaction. The new account holds no ETH and signs nothing on chain itself. The relayer pays the gas and is not reimbursed. This is the only free operation.
- **Everyday operations are reimbursed.** A send, a card update, or a recovery can pay the relayer back out of the account's own balance, up to a cap the passkey signed. The relayer is made whole; the user pays their own gas from their own funds.
- **The user is never overcharged.** The cap (`maxGasPayment`) is part of the signed challenge, so a relayer cannot inflate the charge. The account pays the smaller of the real cost and the cap.

## The reimbursement model

`OndolAccountV3.execute` measures the gas it used, adds a fixed overhead for the parts the meter cannot see, adds an upper-bound L1 fee from the OP-Stack gas oracle, and reimburses whoever paid the gas. It pays the smaller of that amount and the signed cap, and it biases slightly high within the cap so the relayer is never left short.

A cap of zero means sponsored: no reimbursement, exactly like V2. Onboarding uses this path.

The guardian recommends a cap before each signature. `GET /fee` returns a `maxGasPayment` of `(representative gas x gas price + L1 upper bound) x 1.25`, using the same oracle and transaction size the contract charges against, so the number the app shows and the passkey signs matches what the contract will take.

Before relaying, the guardian simulates the exact transaction with `eth_call`. If it would revert, the guardian refuses with a plain sentence and spends no gas.

## Limits on sponsored onboarding

Because onboarding is free, it is capped three ways:

- **Per IP:** a rolling hourly limit per address.
- **Global daily cap:** `SUHO_ONBOARD_DAILY_CAP` (default 200) new accounts per UTC day.
- **One passkey, one onboarding:** the same public key cannot onboard twice.

When the relayer balance falls below its floor (`SUHO_RELAYER_FLOOR_WEI`), sponsored onboarding pauses and the app shows "New account creation is paused. The demo relayer needs a top-up." Reimbursed operations keep working. Nothing fails silently.

## The relayer, and how to check it

The demo relayer address is [`0x8C2BD308Fc0E6A1F96bB81AE9bD53E9f793117D9`](https://sepolia-explorer.giwa.io/address/0x8C2BD308Fc0E6A1F96bB81AE9bD53E9f793117D9). Anyone can top it up or audit its spend on the explorer.

`GET /health` reports the live picture with no secrets: relayer address and balance, the floor and whether onboarding is paused, onboardings today against the cap, relays served, chain head and Flashblocks head, and the last error. It is public so you and the GIWA team can see the service is alive.
