// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OndolProxy} from "../src/OndolProxy.sol";
import {OndolAccountV3} from "../src/OndolAccountV3.sol";

/// @notice Phase G: deploys the upgradeable stack — OndolProxy (the new 7702
///         delegation target) and OndolAccountV3 (capped signed reimbursement +
///         passkey-gated upgradeTo). Guard, AriseModule and SuhoCodeAttester are
///         unchanged and reused; V1/V2 stay deployed (V2 = superseded but still
///         supported for pinned accounts). Neither contract has constructor args.
///
///           forge script script/DeployOndolG.s.sol --rpc-url giwa_sepolia \
///             --broadcast --slow --private-key $DEPLOYER_PRIVATE_KEY
contract DeployOndolG is Script {
    function run() external {
        vm.startBroadcast();
        OndolProxy proxy = new OndolProxy();
        OndolAccountV3 implV3 = new OndolAccountV3();
        vm.stopBroadcast();
        console2.log("OndolProxy:      ", address(proxy));
        console2.log("OndolAccountV3:  ", address(implV3));
        console2.log("Record as ondolProxy / ondolAccountV3Impl in deployments/giwa-sepolia.json");
    }
}
