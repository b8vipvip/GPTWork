import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const adapter = await readFile(new URL('../page-model-evidence.js', import.meta.url), 'utf8');
const content = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const catalog = await readFile(new URL('../model-catalog.js', import.meta.url), 'utf8');

function fixture({ checked = 'gpt-6', expanded = true } = {}) {
  function node(attrs = {}, text = '') {
    return { innerText: text, textContent: text,
      getAttribute: key => attrs[key] ?? null,
      getBoundingClientRect: () => ({width: 130, height: 28}),
      querySelectorAll: () => [],
    };
  }
  const rows = [['gpt-6','GPT-6'],['gpt-5.6-sol','GPT-5.6 Sol'],['gpt-5.5','GPT-5.5']]
    .map(([id,label]) => node({role:'menuitemradio','aria-checked':id===checked?'true':'false'},label));
  const popup = node({role:'menu'});
  popup.querySelectorAll = q => q.includes('menuitemradio') ? rows : [];
  const trigger = node({'aria-haspopup':'menu','aria-label':'选择模型',
    'aria-expanded':expanded?'true':'false','aria-controls':'picker-a'},'High');
  const form = node();
  form.querySelector = q => q === '#prompt-textarea' ? node() : null;
  form.querySelectorAll = q => q.includes("button[aria-haspopup='menu']") || q.includes("button,[role='button']")
    ? [trigger] : [];
  const document = {
    querySelectorAll(q) {
      if (q === "form[data-type='unified-composer']" || q === 'form') return [form];
      if (q.includes("[role='menu']")) return [popup];
      return [];
    },
    getElementById: id => id==='picker-a' ? popup : null,
  };
  const context = vm.createContext({document,getComputedStyle:()=>({display:'block',visibility:'visible'})});
  vm.runInContext(adapter,context);
  return context.__GPTLOCK_PAGE_MODEL_EVIDENCE__.collect();
}

test('official checked GPT-6 row overrides reasoning-only High composer label',()=>{
  const result=fixture();
  assert.equal(result.model,'gpt-6');
  assert.equal(result.reasoning,'high');
  assert.equal(result.modelSource,'official-picker-a-checked');
  assert.deepEqual([...result.candidates],['gpt-6','gpt-5.6-sol','gpt-5.5']);
});

test('closed model menu with only High cannot be interpreted as Sol',()=>{
  const result=fixture({expanded:false});
  assert.equal(result.model,null);
  assert.equal(result.reasoning,'high');
});

test('opened model menu without a selected row leaves model unconfirmed',()=>{
  assert.equal(fixture({checked:null}).model,null);
});

test('normal unlocked status is explicit and model evidence provenance is shown',()=>{
  assert.match(content,/no_locked_model: \\['未锁定', 'off'\\]/);
  assert.match(catalog,/pageModelChecked \\? ' · 菜单勾选'/);
  assert.match(catalog,/未锁定 · 未捕获请求模型/);
  assert.match(catalog,/尚无后端响应证据/);
});
