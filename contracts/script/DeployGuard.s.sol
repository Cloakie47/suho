// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DojangConfig} from "../src/DojangConfig.sol";
import {IDojangScroll} from "../src/interfaces/IDojangScroll.sol";
import {OndolTransferGuard} from "../src/OndolTransferGuard.sol";

/// @notice Guard-only redeploy. Deploys just the corrected OndolTransferGuard,
///         reusing the existing Dojang scroll + accepted attester IDs + threshold.
///         Everything else (SuhoCodeAttester, AriseModule, account impls, proxy)
///         is untouched — this is a policy swap, not a fresh layer.
///
///         Why: the previous guard gated large unverified sends on a one-time code
///         that the guardian minted on demand from a valid passkey signature, which
///         added no independent security while appearing to. The corrected guard
///         allows such sends on passkey authority alone and emits an honest
///         `UnverifiedLargeSend` event. See OndolTransferGuard notice.
///
///         Usage:
///           forge script script/DeployGuard.s.sol --rpc-url giwa_sepolia \
///             --broadcast --private-key $DEPLOYER_KEY
///
///         After deploy: record the address in deployments/giwa-sepolia.json
///         (mark the old guard superseded) and re-point active accounts with a
///         passkey-signed execute([setGuard(newGuard)]). New onboardings pick it up
///         automatically once the guardian reads the updated deployments file.
contract DeployGuard is Script {
    uint256 internal constant OTP_THRESHOLD = 0.01 ether; // demo threshold per spec §4

    function run() external {
        vm.startBroadcast();
        OndolTransferGuard guard = new OndolTransferGuard(
            IDojangScroll(DojangConfig.DOJANG_SCROLL),
            DojangConfig.acceptedAttesterIds(),
            OTP_THRESHOLD
        );
        vm.stopBroadcast();

        console2.log("OndolTransferGuard (new):", address(guard));
        console2.log("otpThreshold:", OTP_THRESHOLD);
        console2.log("Record as deployments.ondolTransferGuard; re-point accounts via setGuard.");
    }
}
