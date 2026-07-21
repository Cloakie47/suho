import { parseAbi } from "viem";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deployments = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../contracts/deployments/giwa-sepolia.json"), "utf8"),
);

export const ADDR = {
  // Suho deployments (contracts/deployments/giwa-sepolia.json)
  suhoCodeAttester: deployments.suhoCodeAttester as `0x${string}`,
  ondolTransferGuard: deployments.ondolTransferGuard as `0x${string}`,
  ariseModule: deployments.ariseModule as `0x${string}`,
  ondolAccountImpl: deployments.ondolAccountImpl as `0x${string}`,
  ondolAccountV2Impl: deployments.ondolAccountV2Impl as `0x${string}`,
  // GIWA-official contracts (mirrors contracts/src/DojangConfig.sol)
  dojangScroll: "0xd5077b67dcb56caC8b270C7788FC3E6ee03F17B9" as `0x${string}`,
  eas: "0x4200000000000000000000000000000000000021" as `0x${string}`,
  // UpnameRegistry proxy ("Upbit Web3 Names") — probe C, binding note 1.
  upnameRegistry: "0x091D00004f21eb2Fc30964A8a4995692d9b49628" as `0x${string}`,
  // GIWAFaucetExtension — the TESTNET FAUCET attester itself (Phase O §O4
  // excavation): payAndIssueEAS() is permissionless+payable, recipient = caller.
  faucetExtension: "0x63CCe2b569A7bC35895ee24306c1512fefc06121" as `0x${string}`,
} as const;

// Suho Card schema (C1): registered 2026-07-21, block 31278333.
export const CARD_SCHEMA_UID = deployments.suhoCardSchemaUid as `0x${string}`;
export const CARD_ERA_START = 31_278_333n;

export const easAbi = parseAbi([
  "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
  "struct Attestation { bytes32 uid; bytes32 schema; uint64 time; uint64 expirationTime; uint64 revocationTime; bytes32 refUID; address recipient; address attester; bool revocable; bytes data; }",
  "function getAttestation(bytes32 uid) view returns (Attestation)",
]);

// Accepted attester IDs, TESTNET FAUCET first (mirrors DojangConfig.acceptedAttesterIds()).
export const ATTESTER_IDS: { name: string; id: `0x${string}` }[] = [
  {
    name: "TESTNET FAUCET",
    id: "0xaa92f8c143657dde575de430aecaea6ca91f2e6072339b16932d426895d8d678",
  },
  {
    name: "UPBIT KOREA",
    id: "0xd99b42e778498aa3c9c1f6a012359130252780511687a35982e8e52735453034",
  },
];

export const dojangScrollAbi = parseAbi([
  "function isVerified(address addr, bytes32 attesterId) view returns (bool)",
]);

export const upnameRegistryAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function ownedTokenId(address owner) view returns (uint256)",
  "function getLabel(bytes32 key) view returns (string)",
  "function hasActiveName(address owner) view returns (bool)",
  "function isClaimable(string name) view returns (bool)",
]);

export const suhoCodeAttesterAbi = parseAbi([
  "function issueCode(address subject, string domain, bytes32 codeHash, uint64 expiry) returns (bytes32)",
  "function isCodeActive(address subject, string domain) view returns (bool)",
]);

export const ariseModuleAbi = parseAbi([
  "function arise(address account, bytes32 newX, bytes32 newY, string code)",
  "error CodeNotFound()",
  "error CodeInvalid()",
  "error CodeExpired()",
  "error CodeAlreadyUsed()",
]);

// Includes every custom error the execute() path can surface (account, guard,
// attester), so viem decodes revert names and the app can branch on them.
export const ondolAccountAbi = parseAbi([
  "struct Call { address target; uint256 value; bytes data; }",
  "function initialize(bytes32 x, bytes32 y, address guard_, address arise_)",
  "function execute(Call[] calls, string otpCode, bytes webAuthnSig) payable",
  "function nonce() view returns (uint256)",
  "function passkey() view returns (bytes32 x, bytes32 y)",
  "function initialized() view returns (bool)",
  "function guard() view returns (address)",
  "error InvalidPasskeySignature()",
  "error NotInitialized()",
  "error CallFailed(uint256 index, bytes returndata)",
  "error OtpRequired()",
  "error CodeNotFound()",
  "error CodeInvalid()",
  "error CodeExpired()",
  "error CodeAlreadyUsed()",
]);

export const ondolV2Abi = parseAbi([
  "function initializeWithSig(bytes32 x, bytes32 y, address guard_, address arise_, uint8 v, bytes32 r, bytes32 s)",
  "function initialized() view returns (bool)",
  "error AlreadyInitialized()",
  "error InvalidInitSignature()",
]);

export const faucetExtensionAbi = parseAbi([
  "function payAndIssueEAS() payable",
  "function fee() view returns (uint256)",
]);

export const registerAbi = parseAbi(["function register(string name)"]);

export const DELEGATION_PREFIX = "0xef0100";
export const explorerTx = (hash: string) => `https://sepolia-explorer.giwa.io/tx/${hash}`;
export const explorerAddr = (a: string) => `https://sepolia-explorer.giwa.io/address/${a}`;
