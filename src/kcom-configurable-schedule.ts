import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from './encoding.js';
export interface KcomTierSchedule { periodMs: string; firstPeriod: string; periodCount: string; tgeBps: string }
export const KCOM_DEFAULT_SCHEDULES: readonly Readonly<KcomTierSchedule>[] = Object.freeze([
  Object.freeze({periodMs:'2592000000',firstPeriod:'1',periodCount:'18',tgeBps:'1000'}),
  Object.freeze({periodMs:'2592000000',firstPeriod:'6',periodCount:'18',tgeBps:'500'}),
  Object.freeze({periodMs:'2592000000',firstPeriod:'10',periodCount:'36',tgeBps:'0'}),
]);
export const KCOM_FAST_TN10_SCHEDULES = Object.freeze(KCOM_DEFAULT_SCHEDULES.map(s => Object.freeze({...s,periodMs:'60000'})));
export function validateKcomSchedule(s: KcomTierSchedule): bigint[] {
  const keys = ['periodMs','firstPeriod','periodCount','tgeBps'] as const;
  if (!s || Object.keys(s).sort().join(',') !== [...keys].sort().join(',')) throw new Error('Exact schedule fields required');
  return keys.map((k,i) => {
    const text = s[k];
    if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)$/.test(text) || text.length > 16) throw new Error(`Invalid ${k}`);
    const n = BigInt(text);
    if (n < [1000n,1n,1n,0n][i]! || n > [31622400000n,1200n,1200n,10000n][i]!) throw new Error(`Invalid ${k}`);
    return n;
  });
}
export function decodeKcomSchedules(terms: Uint8Array, expectedHash: string): KcomTierSchedule[] {
  if (terms.length !== 373 || bytesToHex(blake3(terms)) !== expectedHash ||
      new TextDecoder().decode(terms.slice(0,20)) !== 'kcom.claim.terms/v3\0') throw new Error('Invalid frozen v3 terms');
  const view = new DataView(terms.buffer,terms.byteOffset,terms.byteLength);
  return [0,1,2].map(i => {
    const n = [0,1,2,3].map(j => String(view.getBigInt64(277+i*32+j*8,true)));
    const s = {periodMs:n[0]!,firstPeriod:n[1]!,periodCount:n[2]!,tgeBps:n[3]!};
    validateKcomSchedule(s); return s;
  });
}
