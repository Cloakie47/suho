// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OndolAccountV5} from "../src/OndolAccountV5.sol";
import {SuhoCodeAttester} from "../src/SuhoCodeAttester.sol";

/// @notice Deploy the OndolAccountV5 implementation (V4 + ERC-1271). Like V4 it
///         references the deployed SuhoCodeAttester as an immutable (read correctly
///         through the proxy's delegatecall), so the attester address is the only
///         constructor arg.
///
///         Usage:
///           forge script script/DeployOndolV5.s.sol --rpc-url giwa_sepolia \
///             --broadcast --private-key $DEPLOYER_PRIVATE_KEY
///
///         After deploy: record as `ondolAccountV5Impl` in deployments, sync into
///         app/guardian, source-verify (constructor arg = the attester address).
contract DeployOndolV5 is Script {
    address internal constant SUHO_CODE_ATTESTER = 0x88645529532844C380b40AB68E335CC7a8a0f63B;

    function run() external {
        vm.startBroadcast();
        OndolAccountV5 impl = new OndolAccountV5(SuhoCodeAttester(SUHO_CODE_ATTESTER));
        vm.stopBroadcast();
        console2.log("OndolAccountV5 impl:", address(impl));
        console2.log("codeAttester:", SUHO_CODE_ATTESTER);
    }
}
