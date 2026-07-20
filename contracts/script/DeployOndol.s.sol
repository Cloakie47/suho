// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DojangConfig} from "../src/DojangConfig.sol";
import {IDojangScroll} from "../src/interfaces/IDojangScroll.sol";
import {IEAS, ISchemaRegistry} from "../src/interfaces/IEAS.sol";
import {SuhoCodeAttester} from "../src/SuhoCodeAttester.sol";
import {OndolAccount} from "../src/OndolAccount.sol";
import {OndolTransferGuard} from "../src/OndolTransferGuard.sol";
import {AriseModule} from "../src/AriseModule.sol";

/// @notice Deploys the Ondol layer to GIWA Sepolia: SuhoCodeAttester (reused via
///         env var if already deployed), OndolTransferGuard, AriseModule, and the
///         OndolAccount implementation. Prints a JSON blob for
///         deployments/giwa-sepolia.json.
///
///         Usage:
///           forge script script/DeployOndol.s.sol --rpc-url giwa_sepolia \
///             --broadcast --private-key $DEPLOYER_KEY
///
///         Operational notes from the Phase-0 probes:
///         - EIP-7702 onboarding (cast wallet sign-auth): when the EOA submits its
///           own type-4 tx, the authorization nonce must be tx nonce + 1, because
///           the tx consumes the current nonce before the authorization is applied.
///         - The public RPC is load-balanced and can serve stale state right after
///           a tx; verify post-deploy state from the mined receipt (as --broadcast
///           does) or read twice before trusting an eth_call/eth_getCode result.
contract DeployOndol is Script {
    string internal constant SCHEMA = "bytes32 codeHash, string domain";
    uint256 internal constant OTP_THRESHOLD = 0.01 ether; // demo threshold per spec §4

    function run() external {
        vm.startBroadcast();

        // Reuse an existing SuhoCodeAttester when provided; deploy fresh otherwise.
        address existing = vm.envOr("SUHO_CODE_ATTESTER_ADDRESS", address(0));
        SuhoCodeAttester codes;
        if (existing != address(0)) {
            codes = SuhoCodeAttester(existing);
        } else {
            bytes32 schemaUid;
            try ISchemaRegistry(DojangConfig.SCHEMA_REGISTRY).register(SCHEMA, address(0), true)
            returns (bytes32 uid) {
                schemaUid = uid;
            } catch {
                schemaUid = keccak256(abi.encodePacked(SCHEMA, address(0), true));
            }
            codes = new SuhoCodeAttester(IEAS(DojangConfig.EAS), schemaUid);
        }

        OndolTransferGuard guard = new OndolTransferGuard(
            IDojangScroll(DojangConfig.DOJANG_SCROLL),
            DojangConfig.acceptedAttesterIds(),
            OTP_THRESHOLD,
            codes
        );
        AriseModule arise = new AriseModule(codes);
        OndolAccount accountImpl = new OndolAccount();

        vm.stopBroadcast();

        console2.log("SuhoCodeAttester:", address(codes));
        console2.log("OndolTransferGuard:", address(guard));
        console2.log("AriseModule:", address(arise));
        console2.log("OndolAccount impl:", address(accountImpl));
        console2.log("Record these in deployments/giwa-sepolia.json");
    }
}
