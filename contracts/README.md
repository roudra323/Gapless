# `contracts` — Foundry project

`MockToken` (OpenZeppelin ERC-20, mintable by owner) in `src/`, deploy and `spam-transfers` scripts in `script/`, tests in `test/`.

- **Built in:** Phase 1
- **Read first:** `docs/01-overview-and-roadmap.md` (Phase 1)

## Setup

Dependencies are managed by Soldeer (see `docs/04`). Run all commands from this folder.

```bash
forge soldeer install   # installs forge-std and OpenZeppelin into dependencies/ (git-ignored), checked against soldeer.lock
forge build
forge test
forge fmt --check
```

## Deploy and generate transfers (local anvil)

Start a chain with `anvil` (or `pnpm dev:deps` once Phase 1 adds the compose file). anvil prints its funded accounts; account 0's key is public and only for local use. On a public chain, sign with a keystore (`--account <name>`), never a raw key.

```bash
# 1. Deploy. The signer becomes the owner. Copy TOKEN_ADDRESS and START_BLOCK into .env.
forge script script/DeployMockToken.s.sol:DeployMockToken \
  --rpc-url http://localhost:8545 --broadcast --private-key <anvil account 0 key>

# 2. Mint once, then send TRANSFER_COUNT transfers (default 100) over RECIPIENT_COUNT addresses (default 10).
TOKEN_ADDRESS=<address> TRANSFER_COUNT=500 forge script script/SpamTransfers.s.sol:SpamTransfers \
  --rpc-url http://localhost:8545 --broadcast --slow --private-key <anvil account 0 key>

# 3. Count the events on chain (TRANSFER_COUNT + 1 mint).
cast logs --rpc-url http://localhost:8545 --from-block 0 --address <address> \
  "Transfer(address indexed,address indexed,uint256)"
```

- `START_BLOCK` is read before the deploy transaction, so it is at or before the deploy block. The indexer never starts after the first event.
- `--slow` puts each transfer in its own block. Without it, anvil packs many transfers into a few blocks.
- Recipients are derived from a fixed seed: no keys exist for them, and every run uses the same addresses.
