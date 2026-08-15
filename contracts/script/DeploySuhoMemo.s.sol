// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SuhoMemo} from "../src/SuhoMemo.sol";

/// @notice Deploy the minimal on-chain memo log. No constructor args, no config.
///
///         Usage:
///           forge script script/DeploySuhoMemo.s.sol --rpc-url giwa_sepolia \
///             --broadcast --private-key $DEPLOYER_PRIVATE_KEY
///
///         After deploy: record the address in deployments/giwa-sepolia.json as
///         `suhoMemo`, sync into app/guardian, and source-verify on Blockscout.
contract DeploySuhoMemo is Script {
    function run() external {
        vm.startBroadcast();
        SuhoMemo memo = new SuhoMemo();
        vm.stopBroadcast();
        console2.log("SuhoMemo:", address(memo));
    }
}
