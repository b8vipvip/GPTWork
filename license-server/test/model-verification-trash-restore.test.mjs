// [legacy-core-maintenance] v0.5.200: admin trash+restore preserves stage truth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const source=await readFile(new URL('../account-system-base.mjs',import.meta.url),'utf8');
function statement(variable) {
  const prefix='const '+variable+' = db.prepare(';
  const begin=source.indexOf(prefix);
  assert.ok(begin>=0,'missing '+variable);
  const tick=String.fromCharCode(96);
  const sqlStart=source.indexOf(tick,begin);
  const sqlEnd=source.indexOf(tick,sqlStart+1);
  assert.ok(sqlStart>=0&&sqlEnd>sqlStart,'missing SQL');
  return source.slice(sqlStart+1,sqlEnd);
}
const sqlSave=statement('saveTrashEvidence');
const sqlRestore=statement('restoreEvidence');
const fields=[
  'user_id','model_id','request_confirmed','response_confirmed',
  'native_request_model','native_response_model','chat_transport_model','chat_response_model',
  'chat_lock_request_confirmed','chat_lock_response_confirmed','native_stage_complete','chat_lock_stage_complete',
  'last_chat_attempt_transport','last_chat_attempt_response','first_seen_at','last_seen_at',
];
const columns=[
  'user_id INTEGER NOT NULL','model_id TEXT NOT NULL',
  'request_confirmed INTEGER','response_confirmed INTEGER',
  'native_request_model TEXT','native_response_model TEXT',
  'chat_transport_model TEXT','chat_response_model TEXT',
  'chat_lock_request_confirmed INTEGER','chat_lock_response_confirmed INTEGER',
  'native_stage_complete INTEGER NOT NULL DEFAULT 0',
  'chat_lock_stage_complete INTEGER NOT NULL DEFAULT 0',
  'last_chat_attempt_transport TEXT','last_chat_attempt_response TEXT',
  'first_seen_at TEXT NOT NULL','last_seen_at TEXT NOT NULL',
].join(',');

test('completed native and negative Chat-lock stages survive deletion and restore',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE shared_model_account_seen('+columns+'); CREATE TABLE shared_model_account_seen_trash('+columns+');');
    const original=[
      42,'gpt-6-astra',1,1,'gpt-6-astra-wm',null,null,null,
      1,0,1,1,'gpt-6-astra-wm','gpt-6',
      '2026-10-08T10:00:00Z','2026-10-08T11:00:00Z',
    ];
    db.prepare('INSERT INTO shared_model_account_seen VALUES('+Array(16).fill('?').join(',')+')').run(...original);
    const seen=db.prepare('SELECT * FROM shared_model_account_seen').get();
    db.prepare(sqlSave).run(...fields.map(x=>seen[x]));
    db.exec('DELETE FROM shared_model_account_seen');
    assert.equal(db.prepare('SELECT count(*) AS count FROM shared_model_account_seen').get().count,0);
    const trash=db.prepare('SELECT * FROM shared_model_account_seen_trash').get();
    db.prepare(sqlRestore).run(...fields.map(x=>trash[x]));
    const restored=db.prepare('SELECT * FROM shared_model_account_seen').get();
    assert.deepEqual(fields.map(x=>restored[x]),original);
    assert.equal(restored.native_stage_complete,1);
    assert.equal(restored.chat_lock_stage_complete,1);
    assert.equal(restored.chat_transport_model,null);
    assert.equal(restored.chat_lock_response_confirmed,0);
  } finally {db.close();}
});

test('existing recycle bins are upgraded with completion and negative attempt fields',()=>{
  for(const field of ['native_stage_complete','chat_lock_stage_complete','last_chat_attempt_transport','last_chat_attempt_response']){
    assert.match(source,new RegExp("ensureColumn\\('shared_model_account_seen_trash', '"+field+"'"));
  }
  assert.match(source,/const selectTrashEvidence = db\.prepare\('SELECT \* FROM shared_model_account_seen_trash/);
  assert.match(source,/DELETE FROM shared_model_catalog WHERE model_id=\?/);
});

test('no eligibility, account ownership or secondary model-decision owner is introduced',()=>{
  assert.match(source,/clientEligibleOnly: true/);
  assert.match(source,/accountModelVerificationLedger\(session\.user_id\)/);
  assert.match(source,/native_stage_complete=MAX\(shared_model_account_seen\.native_stage_complete,excluded\.native_stage_complete\)/);
});
