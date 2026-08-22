// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OndolAccountV3} from "../src/OndolAccountV3.sol";

/// @dev Demo-only upgrade target: a full V3 with an extra marker() selector, so a
///      passkey-signed upgradeTo can be shown to install a genuinely NEW
///      implementation (a selector the old impl did not have), not just a pointer
///      to identical bytecode. Not part of the production stack.
contract UpgradeMarkerV3 is OndolAccountV3 {
    function marker() external pure returns (uint256) {
        return 0xC0DE;
    }
}

contract DeployUpgradeMarker is Script {
    function run() external {
        vm.startBroadcast();
        UpgradeMarkerV3 m = new UpgradeMarkerV3();
        vm.stopBroadcast();
        console2.log("UpgradeMarkerV3:", address(m));
    }
}
