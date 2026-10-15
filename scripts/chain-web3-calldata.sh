#!/bin/sh
# Regenerate test/fixtures/chain-web3-calldata.json: calldata built offline by
# web3 (inside the shipped Docker neuron image, no network) from the ABIs in
# neuron/neuron-lite/satorineuron/base_{predict,claim}.py. src/chain tests check
# viem's calldata against it.
set -e
N=/code/Satori/neuron/neuron-lite/satorineuron
python3 - "$N" <<'PY' | docker run --rm -i --network none --entrypoint python satorinet/satori-lite:latest - > "$(dirname "$0")/../test/fixtures/chain-web3-calldata.json"
import sys
n = sys.argv[1]
bp, bc = open(n + '/base_predict.py').read(), open(n + '/base_claim.py').read()
print(f'''import json, types, web3
from web3 import Web3
bp = types.ModuleType('bp'); exec(compile({bp!r}, 'base_predict.py', 'exec'), bp.__dict__)
bc = types.ModuleType('bc'); exec(compile({bc!r}, 'base_claim.py', 'exec'), bc.__dict__)
w3 = Web3()
A = "0x9f505692808622fc1F0fbb53324262162C788762"
def enc(abi, fn, *args):
    c = w3.eth.contract(address="0x0000000000000000000000000000000000000001", abi=abi)
    return getattr(c.functions, fn)(*args)._encode_transaction_data()
out = {{
 "predictMultipleWithPayloads([(1,0x01),(7,0x02)])": enc(bp.ENGINE_ABI, "predictMultipleWithPayloads", [(1, bytes([1])), (7, bytes([2]))]),
 "predictedStreamsCount(A,20741)": enc(bp.ENGINE_ABI, "predictedStreamsCount", A, 20741),
 "binaryGameByStream(1)": enc(bp.GAMES_ABI, "binaryGameByStream", 1),
 "delegatePredictionPower(A)": enc(bp.HUB_ABI, "delegatePredictionPower", A),
 "delegatePredictionPower(0x0)": enc(bp.HUB_ABI, "delegatePredictionPower", bp.ZERO_ADDRESS),
 "setPredictorFee(0)": enc(bp.REWARDS_ABI, "setPredictorFee", 0),
 "claimMerkle(10,[0x22..])": enc(bc.MERKLE_ABI, "claimMerkle", 10, ["0x" + "22"*32]),
 "claimAirdrop()": enc(bc.AIRDROP_ABI, "claimAirdrop"),
}}
print(json.dumps({{"address": A, "source": "satorinet/satori-lite:latest, web3 " + web3.__version__, "calldata": out}}, indent=2))
''')
PY
