// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OndolSpendingGuard} from "../src/OndolSpendingGuard.sol";
import {SuhoCodeAttester} from "../src/SuhoCodeAttester.sol";

/// @notice Deploy the OndolSpendingGuard (bank model). Constructor args: the
///         deployed SuhoCodeAttester (for the email second factor) and the default
///         per-transaction / rolling-daily limits every account starts with.
///
///         Usage:
///           forge script script/DeployOndolSpendingGuard.s.sol --rpc-url giwa_sepolia \
///             --broadcast --private-key $DEPLOYER_PRIVATE_KEY
///
///         After deploy: record as `ondolSpendingGuard` in deployments, sync into
///         app/guardian, source-verify (ctor args = attester, defaultPerTx, defaultDaily).
contract DeployOndolSpendingGuard is Script {
    address internal constant SUHO_CODE_ATTESTER = 0x88645529532844C380b40AB68E335CC7a8a0f63B;
    uint128 internal constant DEFAULT_PER_TX = 0.01 ether;
    uint128 internal constant DEFAULT_DAILY = 0.02 ether;

    function run() external {
        vm.startBroadcast();
        OndolSpendingGuard guard =
            new OndolSpendingGuard(SuhoCodeAttester(SUHO_CODE_ATTESTER), DEFAULT_PER_TX, DEFAULT_DAILY);
        vm.stopBroadcast();
        console2.log("OndolSpendingGuard:", address(guard));
        console2.log("codeAttester:", SUHO_CODE_ATTESTER);
        console2.log("defaultPerTx (wei):", DEFAULT_PER_TX);
        console2.log("defaultDaily (wei):", DEFAULT_DAILY);
    }
}
