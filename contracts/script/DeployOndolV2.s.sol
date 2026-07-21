// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OndolAccountV2} from "../src/OndolAccountV2.sol";

/// @notice Phase O §O2: deploys the OndolAccountV2 implementation (sig-gated
///         initialization for gasless onboarding). Guard, AriseModule and
///         SuhoCodeAttester are unchanged and reused; v1 stays deployed as
///         superseded.
///
///           forge script script/DeployOndolV2.s.sol --rpc-url giwa_sepolia \
///             --broadcast --private-key $DEPLOYER_KEY
contract DeployOndolV2 is Script {
    function run() external {
        vm.startBroadcast();
        OndolAccountV2 impl = new OndolAccountV2();
        vm.stopBroadcast();
        console2.log("OndolAccountV2 impl:", address(impl));
        console2.log("Record as ondolAccountV2Impl in deployments/giwa-sepolia.json");
    }
}
