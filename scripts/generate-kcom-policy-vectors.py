#!/usr/bin/env python3
"""Independent Python/BLAKE3 reference for draft TS eligibility encoding.
Run manually with Python's blake3 package; npm tests consume the committed vectors.
"""
import json
from pathlib import Path
import hashlib
from blake3 import blake3

def h(n): return f'{n:064x}'
def digest(domain, *parts): return blake3(('kcom.claim.'+domain+'/v1\0').encode()+b''.join(parts)).hexdigest()
def raw(v): return bytes.fromhex(v)
def u(v,n): return v.to_bytes(n,'little')
BASE=2_000_000_000_000_000
provenance={'materializationHash':h(10),'membershipSnapshotHash':h(11),'integrityManifestHash':h(12),'sourceManifestHashes':[h(13),h(14),h(15)],'cutoffMs':'1794700800000'}
fixtures=[]
for count in [1,3,5]:
    leaves=[{'index':i,'authority':{'scheme':i%5,'identifier':h(i+1)},'baseEntitlementRaw':str(BASE//count)} for i in range(count)]
    width=1
    while width<count: width*=2
    row=[]
    for i in range(width):
        if i<count:
            leaf=leaves[i]
            row.append(digest('eligibility.leaf',raw(h(1)),u(i,4),u(leaf['authority']['scheme'],1),raw(leaf['authority']['identifier']),u(int(leaf['baseEntitlementRaw']),8)))
        else:row.append(digest('eligibility.padding',raw(h(1)),u(i,4)))
    leaf_hashes=row[:count]
    levels=[row]
    while len(row)>1:
        row=[digest('eligibility.node',raw(row[i]),raw(row[i+1])) for i in range(0,len(row),2)]
        levels.append(row)
    unsigned={'schema':'kcom-claim-eligibility/v1','status':'draft-offline-unapproved-contract-format','campaignId':h(1),'tokenId':h(2),'decimals':8,'basePoolRaw':str(BASE),'campaignBudgetRaw':'10000000000000000','totalBaseEntitlementRaw':str(BASE//count*count),'baseRoundingReserveRaw':str(BASE%count),'provenance':provenance,'root':row[0],'leaves':leaves}
    content_hash=hashlib.sha256(json.dumps(unsigned,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    proofs=[]
    for leaf in leaves:
        i=leaf['index'];siblings=[]
        for layer in levels[:-1]:siblings.append(layer[i^1]);i//=2
        proofs.append({'campaignId':h(1),'leaf':leaf,'leafCount':count,'siblings':siblings})
    fixtures.append({'manifest':{**unsigned,'contentHash':content_hash},'leafHashes':leaf_hashes,'proofs':proofs,'nullifiers':[digest('nullifier',raw(h(1)),u(l['authority']['scheme'],1),raw(l['authority']['identifier'])) for l in leaves]})
Path(__file__).resolve().parent.parent.joinpath('test/fixtures/kcom-claim-policy-golden.json').write_text(json.dumps({'generator':'independent Python blake3/hashlib, not TS implementation','cases':fixtures},indent=2)+'\n')

# Separate independent integer allocation reference, including every tier/absent
# combination for unequal weights. These expectations do not call the TS module.
import itertools
base_amounts=[BASE//6,BASE//3,BASE-BASE//6-BASE//3]
settlements=[]
for tiers in itertools.product(range(4),repeat=3):
    selected=[i for i,t in enumerate(tiers) if t]
    wm=sum(base_amounts[i] for i in selected if tiers[i]>=2)
    wl=sum(base_amounts[i] for i in selected if tiers[i]==3)
    unclaimed=BASE-sum(base_amounts[i] for i in selected)
    rows=[]
    for i in selected:
        b=base_amounts[i]
        medium=3_000_000_000_000_000*b//wm if tiers[i]>=2 and wm else 0
        long=5_000_000_000_000_000*b//wl if tiers[i]==3 and wl else 0
        unused=unclaimed*b//wl if tiers[i]==3 and wl else 0
        rows.append({'leafIndex':i,'baseRaw':str(b),'mediumBoostRaw':str(medium),'longBoostRaw':str(long),'unclaimedRedistributionRaw':str(unused),'finalAllocationRaw':str(b+medium+long+unused)})
    total=sum(int(r['finalAllocationRaw']) for r in rows)
    settlements.append({'tiers':list(tiers),'liabilityRaw':str(total),'treasuryRaw':str(10_000_000_000_000_000-total),'allocations':rows})
Path(__file__).resolve().parent.parent.joinpath('test/fixtures/kcom-claim-settlement-golden.json').write_text(json.dumps({'generator':'independent Python integer reference','baseEntitlementsRaw':list(map(str,base_amounts)),'cases':settlements},indent=2)+'\n')
