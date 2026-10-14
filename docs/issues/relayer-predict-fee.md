# Gasless predictions: the identity can't pay the relayer's Predict fee

**Status:** owner ruling needed · **Matters for:** removing the Base ETH requirement (later)

## Context (verified)

- `SatoriHub.relay` executes Predict, Claim, DelegatePrediction,
  SetPredictorFee and others for an EIP-712-signed request; the relayer pays gas
  and takes a SATORI fee (`contract/satori/contracts/next/SatoriHub.sol:899-990`).
- Live at `https://app.satorinet.io/relayer`, CORS open (probed 2026-10-14).
- Fee policy: default 0.25 SATORI, Claim 0 (`contract/relayer/fees.json`).
- The README says wallets with a live prediction delegation (locked) cannot pay
  a SATORI fee (`contract/relayer/README.md:37-39`).

## Problem

The identity signs predictions and holds no SATORI (inferred: nothing funds it).
So a gasless daily batch fails on the fee, and the user must fund Base ETH on
two addresses instead, as Docker does today.

## Options

1. Predict fee 0 in `fees.json` (the relayer bears gas for predictions).
2. Keep the fee; the app tells users to send a little SATORI to the identity.
3. Keep v1 on ETH gas (current design) and decide later.
