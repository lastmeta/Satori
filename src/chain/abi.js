// Minimal ABIs: only what the chain module calls. Copied from the contract
// artifacts (contract/satori/artifacts/contracts/**), which match
// neuron/neuron-lite/satorineuron/base_predict.py:29-125 and base_claim.py:19-76.
// abi.test.js checks each entry against the artifacts.
import { parseAbi } from 'viem';

export const registryAbi = parseAbi([
  'function getAllDataStreams() view returns (uint32[])',
  'function getHistoryPage(uint32 streamId, uint256 offset, uint256 limit) view returns (int232[] values, uint24[] entryHours, uint16 total)',
  'function getLatestUpdateInfo(uint32 streamId) view returns (uint16 count, uint64 latestHour, uint64 lastUpdateTimestamp, uint24 minCadenceMinutes)',
]);

export const gamesAbi = parseAbi([
  'function binaryGameByStream(uint32) view returns (uint32)',
]);

export const engineAbi = parseAbi([
  'struct PredictionRequestWithPayload { uint32 gameId; bytes payload; }',
  'function predictMultipleWithPayloads(PredictionRequestWithPayload[] requests)',
  'function predictedStreamsCount(address, uint256) view returns (uint256)',
  // the per-game reverts the simulate drops (SatoriEngine.sol:792-810)
  'error EmptyStream()',
  'error DuplicatePrediction()',
  'error StaleValue()',
]);

export const hubAbi = parseAbi([
  'function delegatePredictionPower(address delegate)',
  'function claim() returns (uint256)',
]);

export const tokenAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function transferLockedUntil(address user) view returns (uint24)',
]);

export const rewardsAbi = parseAbi([
  'function setPredictorFee(uint16 bps)',
  'function effectivePredictorFee(address predictor) view returns (uint16)',
  'function predictionDelegateInfo(address) view returns (address delegate, uint96 power)',
  'function unclaimedRewards(address) view returns (uint256)',
]);

export const merkleAbi = parseAbi([
  'function claimMerkle(uint256 lifetimeEntitlement, bytes32[] proof)',
  'function alreadyMintedTo(address) view returns (uint256)',
  'function merkleRoot() view returns (bytes32)',
]);

export const airdropAbi = parseAbi([
  'function claimAirdrop()',
  'function claimableAirdrop(address user) view returns (uint256)',
  'function airdropAllocation(address) view returns (uint256)',
  'function airdropClaimed(address user) view returns (uint256)',
]);

// Multicall3 (same address on every chain), so ETH balances join the multicall.
export const ethBalanceAbi = parseAbi([
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);
