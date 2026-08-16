// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OndolAccountV4} from "../src/OndolAccountV4.sol";
import {SuhoCodeAttester} from "../src/SuhoCodeAttester.sol";

/// @notice Deploy the OndolAccountV4 implementation. The account references the
///         deployed SuhoCodeAttester as an immutable (read correctly through the
///         proxy's delegatecall), so the attester address is the only arg.
///
///         Usage:
///           forge script script/DeployOndolV4.s.sol --rpc-url giwa_sepolia \
///             --broadcast --private-key $DEPLOYER_PRIVATE_KEY
///
///         After deploy: record as `ondolAccountV4Impl` in deployments, sync into
///         app/guardian, source-verify (constructor arg = the attester address).
contract DeployOndolV4 is Script {
    address internal constant SUHO_CODE_ATTESTER = 0x88645529532844C380b40AB68E335CC7a8a0f63B;

    function run() external {
        vm.startBroadcast();
        OndolAccountV4 impl = new OndolAccountV4(SuhoCodeAttester(SUHO_CODE_ATTESTER));
        vm.stopBroadcast();
        console2.log("OndolAccountV4 impl:", address(impl));
        console2.log("codeAttester:", SUHO_CODE_ATTESTER);
    }
}
