//! Execute the exact signed PSKTs emitted by consolidation-transaction.mjs.
//! Test fixtures only. No RPC, private wallet files or broadcast capability.
use kaspa_consensus_core::{
    Hash,
    hashing::sighash::SigHashReusedValuesUnsync,
    tx::{
        CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionInput,
        TransactionOutpoint, TransactionOutput, UtxoEntry, VerifiableTransaction,
    },
};
use kaspa_txscript::{
    EngineCtx, EngineFlags, TxScriptEngine, caches::Cache, covenants::CovenantsContext,
};
use serde_json::Value;
use std::{env, fs, str::FromStr};
fn bytes(s: &str) -> Vec<u8> {
    assert_eq!(s.len() % 2, 0);
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn num(v: &Value) -> u64 {
    v.as_u64()
        .unwrap_or_else(|| v.as_str().unwrap().parse().unwrap())
}
fn hash(v: &Value) -> Hash {
    Hash::from_str(v.as_str().unwrap()).unwrap()
}
fn spk(v: &Value) -> ScriptPublicKey {
    let b = bytes(v.as_str().unwrap());
    ScriptPublicKey::new(u16::from_le_bytes([b[0], b[1]]), b[2..].to_vec().into())
}
fn main() {
    let file = env::args().nth(1).expect("transactions.json path");
    let cases: Vec<Value> = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
    assert!(!cases.is_empty());
    let mut checked = 0;
    for case in cases {
        let t = &case["signedTransaction"];
        let count = num(&case["count"]) as usize;
        let inputs: Vec<_> = t["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| {
                TransactionInput::new_with_compute_budget(
                    TransactionOutpoint::new(hash(&i["transactionId"]), num(&i["index"]) as u32),
                    bytes(i["signatureScript"].as_str().unwrap()),
                    num(&i["sequence"]),
                    num(&i["computeBudget"]) as u16,
                )
            })
            .collect();
        let outputs = t["outputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| TransactionOutput {
                value: num(&o["value"]),
                script_public_key: spk(&o["scriptPublicKey"]),
                covenant: if o["covenant"].is_null() {
                    None
                } else {
                    Some(CovenantBinding {
                        authorizing_input: num(&o["covenant"]["authorizingInput"]) as u16,
                        covenant_id: hash(&o["covenant"]["covenantId"]),
                    })
                },
            })
            .collect();
        let tx = Transaction::new(
            num(&t["version"]) as u16,
            inputs,
            outputs,
            num(&t["lockTime"]),
            Default::default(),
            num(&t["gas"]),
            bytes(t["payload"].as_str().unwrap()),
        );
        let cid = hash(&case["built"]["metadata"]["covenantId"]);
        let entries = t["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(idx, i)| {
                let u = &i["utxo"];
                UtxoEntry::new(
                    num(&u["amount"]),
                    spk(&u["scriptPublicKey"]),
                    num(&u["blockDaaScore"]),
                    u["isCoinbase"].as_bool().unwrap(),
                    if idx < count { Some(cid) } else { None },
                )
            })
            .collect();
        let populated = PopulatedTransaction::new(&tx, entries);
        let ctx = CovenantsContext::from_tx(&populated).expect("valid covenant context");
        let reused = SigHashReusedValuesUnsync::new();
        let cache = Cache::new(10000);
        let mut failures = 0;
        for (idx, input) in tx.inputs.iter().enumerate() {
            let mut vm = TxScriptEngine::from_transaction_input(
                &populated,
                input,
                idx,
                populated.utxo(idx).unwrap(),
                EngineCtx::new(&cache)
                    .with_reused(&reused)
                    .with_covenants_ctx(&ctx),
                EngineFlags {
                    covenants_enabled: true,
                    sigop_script_units: 100_000.into(),
                },
            );
            if let Err(e) = vm.execute() {
                failures += 1;
                eprintln!("{} input {}: {:?}", case["name"], idx, e);
            }
            checked += 1;
        }
        if case["expectFailure"].as_bool().unwrap_or(false) {
            assert!(failures > 0, "negative case accepted: {}", case["name"]);
        } else {
            assert_eq!(
                failures, 0,
                "contract rejected {} / {} inputs",
                case["profileId"], count
            );
        }
        println!(
            "PASS {} {} inputs {}",
            case["profileId"], count, case["name"]
        );
    }
    println!("Verified {checked} input executions, including funding signatures");
}
