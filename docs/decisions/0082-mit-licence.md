# ADR 0082: The repository is MIT licensed

## Status
Accepted

## Context
Bind is being submitted to the Arc showcase, which requires the code to stay open source and its building blocks to be usable by other builders. The repository had no licence file, so nothing legally allowed reuse. `contracts/src/BindSettlement.sol` already carried `SPDX-License-Identifier: MIT`, and the SDK and MCP packages said `UNLICENSED`.

## Decision
Use the MIT licence for the whole repository (`LICENSE`, copyright "Bind contributors"). The SDK and MCP package metadata now say `MIT`. Both stay `private: true`: choosing a licence is not a decision to publish to npm.

MIT is the most permissive widely understood licence, matches the contract header and the Solidity and Foundry ecosystem, and lets other builders fork any piece without conditions beyond keeping the notice. Apache-2.0 was the alternative; it adds an explicit patent grant but also notice and change-statement duties, and would have made the contract header inconsistent with the rest of the repository.

## Consequences
- Anyone may use, copy, modify and sell this code. The licence cannot be taken back for versions already published.
- Third-party code keeps its own licence; no vendored code was relicensed.
- The owner may later add a copyright holder name or switch to dual licensing for new work; that needs a new decision.
