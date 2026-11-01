/**
 * The RPC answer for a range failed a consistency check (docs/03 "RPC consistency checks"), for
 * example because the node that answered is behind. Retryable: try the same range again later.
 * Never commit a range that raised it.
 */
export class RangeInconsistentError extends Error {
  constructor(reason: string) {
    super(`Inconsistent RPC answer for the range: ${reason}`);
    this.name = 'RangeInconsistentError';
  }
}

/**
 * The chain's hash of the checkpoint block differs from the stored `last_block_hash`: a reorg at
 * or below the checkpoint. Not an error for the process: the loop runs the proven rewind
 * (docs/03 "Reorg guard") and continues from the rewound checkpoint.
 */
export class AnchorMismatchError extends Error {
  constructor(
    readonly block: bigint,
    readonly storedHash: string,
    readonly chainHash: string,
  ) {
    super(`Reorg at or below block ${block}: stored hash ${storedHash}, chain hash ${chainHash}`);
    this.name = 'AnchorMismatchError';
  }
}

/**
 * The fenced checkpoint update changed 0 rows: another writer moved the checkpoint (docs/03
 * "Checkpoint fence"). Not retryable: the transaction is rolled back and ingestion stops.
 */
export class CheckpointFenceError extends Error {
  constructor(readonly expectedLastBlock: bigint) {
    super(`The checkpoint is no longer at block ${expectedLastBlock}; another writer moved it`);
    this.name = 'CheckpointFenceError';
  }
}

/**
 * `TOKEN_ADDRESS` holds no contract code on this chain (docs/03 "Startup"). Not retryable: a
 * wrong address would index nothing, so the process exits non-zero.
 */
export class TokenNotContractError extends Error {
  constructor(readonly tokenAddress: string) {
    super(`TOKEN_ADDRESS ${tokenAddress} has no contract code on this chain`);
    this.name = 'TokenNotContractError';
  }
}
