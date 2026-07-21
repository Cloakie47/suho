import { encodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from "viem";
import type { Call } from "./chain";
import { CARD_SCHEMA_UID, DEMO_ACCOUNT, EAS_ADDRESS } from "./config";

/// C2/C3: the card attestation is made BY the Ondol account itself — the app
/// builds EAS attest()/revoke() calldata and routes it through execute() with a
/// passkey signature. The guardian only relays; no guardian-owned key attests.

const easAbi = parseAbi([
  "struct AttestationRequestData { address recipient; uint64 expirationTime; bool revocable; bytes32 refUID; bytes data; uint256 value; }",
  "struct AttestationRequest { bytes32 schema; AttestationRequestData data; }",
  "struct RevocationRequestData { bytes32 uid; uint256 value; }",
  "struct RevocationRequest { bytes32 schema; RevocationRequestData data; }",
  "function attest(AttestationRequest request) payable returns (bytes32)",
  "function revoke(RevocationRequest request) payable",
]);

export interface CardFields {
  displayName: string;
  contact: string;
  remarks: string;
}

const ZERO32 = ("0x" + "0".repeat(64)) as Hex;

/** Build the execute() batch for a card version: attest the new card
 *  (refUID = previous version or 0 for v1), and — when updating — revoke the
 *  old version atomically in the same batch (C3). */
export function buildCardCalls(fields: CardFields, prevUid: Hex | null): Call[] {
  const attestCall: Call = {
    target: EAS_ADDRESS,
    value: 0n,
    data: encodeFunctionData({
      abi: easAbi,
      functionName: "attest",
      args: [
        {
          schema: CARD_SCHEMA_UID,
          data: {
            recipient: DEMO_ACCOUNT,
            expirationTime: 0n,
            revocable: true,
            refUID: prevUid ?? ZERO32,
            data: encodeAbiParameters(
              [{ type: "string" }, { type: "string" }, { type: "string" }],
              [fields.displayName, fields.contact, fields.remarks],
            ),
            value: 0n,
          },
        },
      ],
    }),
  };
  if (!prevUid) return [attestCall];
  return [
    attestCall,
    {
      target: EAS_ADDRESS,
      value: 0n,
      data: encodeFunctionData({
        abi: easAbi,
        functionName: "revoke",
        args: [{ schema: CARD_SCHEMA_UID, data: { uid: prevUid, value: 0n } }],
      }),
    },
  ];
}
