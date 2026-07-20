// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {SuhoCodeAttester} from "../src/SuhoCodeAttester.sol";
import {DojangConfig} from "../src/DojangConfig.sol";
import {IEAS, ISchemaRegistry} from "../src/interfaces/IEAS.sol";

/// @notice Registers Suho's code schema on the real SchemaRegistry (resolver 0,
///         revocable) and deploys SuhoCodeAttester bound to the real EAS predeploy.
///
///         Usage (GIWA Sepolia):
///           forge script script/DeploySuhoCodeAttester.s.sol \
///             --rpc-url giwa_sepolia --broadcast --private-key $DEPLOYER_KEY
contract DeploySuhoCodeAttester is Script {
    string internal constant SCHEMA = "bytes32 codeHash, string domain";

    function run() external {
        vm.startBroadcast();

        bytes32 schemaUid;
        try ISchemaRegistry(DojangConfig.SCHEMA_REGISTRY).register(SCHEMA, address(0), true) returns (bytes32 uid) {
            schemaUid = uid;
        } catch {
            // Schema string already registered (registry reverts on duplicates);
            // its UID is deterministic: keccak256(schema, resolver, revocable).
            schemaUid = keccak256(abi.encodePacked(SCHEMA, address(0), true));
        }

        SuhoCodeAttester attester = new SuhoCodeAttester(IEAS(DojangConfig.EAS), schemaUid);

        vm.stopBroadcast();

        console2.log("SuhoCodeAttester:", address(attester));
        console2.log("Schema UID:");
        console2.logBytes32(schemaUid);
        console2.log('Record both in deployments/giwa-sepolia.json:');
        console2.log('{"suhoCodeAttester": "<address>", "schemaUid": "<uid>"}');
    }
}
