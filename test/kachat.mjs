import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kaChatSigningMessage, buildKaChatPayload, kaChatPublicKey, kaChatDiscussionKey,
  kaChatSelfSendRequest, kaChatRootText } from '../dist/kachat.js';
const key = 'ab'.repeat(32), id = 'cd'.repeat(32), sig = 'ef'.repeat(64);
const verifier = { verifyMessage: () => true };
test('preserves upstream compressed author identity and accepts x-only wallet keys', () => {
  assert.equal(kaChatPublicKey(`03${key}`), `03${key}`);
  assert.equal(kaChatPublicKey(key), `02${key}`);
});
test('post and reply match the upstream wire format including Unicode marker', () => {
  const content = 'שלום 😀 : test';
  const b64 = Buffer.from('\u2060' + content).toString('base64');
  assert.equal(kaChatSigningMessage({ kind: 'post', text: content }), `${b64}:[]`);
  const action = { kind: 'reply', postId: id, text: content };
  assert.equal(Buffer.from(buildKaChatPayload(action, key, sig, verifier)).toString(),
    `kchat:1:reply:02${key}:${sig}:${id}:${b64}:[]`);
});
test('like and unlike sign the target and author', () => {
  for (const vote of ['upvote', 'unvote']) {
    assert.equal(kaChatSigningMessage({kind:'vote',postId:id,authorPublicKey:key,vote}), `${id}:${vote}:02${key}`);
  }
});
test('reject invalid identity, signature, text and unsupported actions', () => {
  assert.throws(() => kaChatPublicKey('bad'));
  assert.throws(() => kaChatSigningMessage({kind:'post',text:' '}));
  assert.throws(() => kaChatSigningMessage({kind:'post',text:'😀'.repeat(501)}));
  assert.throws(() => kaChatSigningMessage({kind:'reply',postId:'no',text:'valid'}));
  assert.throws(() => kaChatSigningMessage({kind:'delete'}));
  assert.throws(() => buildKaChatPayload({kind:'post',text:'valid'},key,sig,{verifyMessage:()=>false}));
});
test('network and canonical identity isolate discussion roots', () => {
  assert.notEqual(kaChatDiscussionKey('mainnet',id),kaChatDiscussionKey('testnet-10',id));
  assert.equal(kaChatRootText('testnet-10',id),`KaspaCom token discussion\ntestnet-10:${id}`);
  assert.throws(() => kaChatDiscussionKey('testnet-12',id));
});
test('self-send returns principal to the author and rejects network mismatch', () => {
  const payload=buildKaChatPayload({kind:'post',text:'test'},key,sig,verifier);
  const request=kaChatSelfSendRequest({network:'testnet-10',walletAddress:'kaspatest:example',payload,entries:[]});
  assert.deepEqual(request.outputs,[{address:'kaspatest:example',amount:20000000n}]);
  assert.equal(request.changeAddress,'kaspatest:example');
  assert.equal(request.payload,Buffer.from(payload).toString('hex'));
  assert.throws(()=>kaChatSelfSendRequest({network:'mainnet',walletAddress:'kaspatest:example',payload,entries:[]}));
});
