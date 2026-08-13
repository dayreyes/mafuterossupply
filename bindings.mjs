// Checks the app's view layer without a browser.
//
// Pulls the logic out of index.html, runs renderVals() against a stub of the
// dc-runtime base class, and asserts that every {{ binding }} the template uses
// actually gets a value — in both languages, and in the states that matter
// (empty shop, stocked shop, owner signed in). A missing binding renders as a
// visible placeholder box in the real app, which is exactly the kind of thing
// that only shows up on someone's phone at the worst moment.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const template = html.slice(html.indexOf('<x-dc>'), html.indexOf('</x-dc>'));
const script = /<script type="text\/x-dc" data-dc-script>([\s\S]*?)<\/script>/.exec(html)[1];

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + JSON.stringify(extra).slice(0, 400) : '')); }
};

// ── what the template asks for ──────────────────────────────────────────────
const loopVars = new Set([...template.matchAll(/as="([A-Za-z0-9_]+)"/g)].map(m => m[1]));
const wanted = new Set();
for (const m of template.matchAll(/\{\{([^}]*)\}\}/g)) {
  const head = m[1].trim().split('.')[0].split('(')[0].trim();
  if (head && !/^\d/.test(head) && head !== 'true' && head !== 'false') wanted.add(head);
}
for (const v of loopVars) wanted.delete(v);

// Loop bodies: {{ o.total }} means the `orders` rows need a `total` field.
const loopFields = {};
for (const m of template.matchAll(/<sc-for list="\{\{\s*([A-Za-z0-9_.]+)\s*\}\}"\s+as="([A-Za-z0-9_]+)"([\s\S]*?)<\/sc-for>/g)) {
  const [, list, as, body] = m;
  const fields = new Set();
  for (const f of body.matchAll(new RegExp('\\{\\{\\s*' + as + '\\.([A-Za-z0-9_]+)', 'g'))) fields.add(f[1]);
  const key = list.split('.').pop();
  loopFields[key] = new Set([...(loopFields[key] || []), ...fields]);
}

// ── run the logic ───────────────────────────────────────────────────────────
class DCLogic {
  constructor() { this.props = {}; }
  setState(patch) { Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch); }
}

const sandbox = {
  DCLogic,
  console,
  location: { protocol: 'https:', origin: 'https://shop.test', pathname: '/', href: 'https://shop.test/' },
  navigator: {},
  document: { createElement: () => ({ style: {}, setAttribute() {} }), body: { appendChild() {}, removeChild() {} } },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }),
  setInterval: () => 0, clearInterval() {}, setTimeout: () => 0,
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Promise, Error, isNaN
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(script + '\n;globalThis.__Component = Component;', sandbox);
const Component = sandbox.__Component;

const CFG = {
  shopName: "Mafutero's Supply", pickupNote: 'Behind the shop', contact: '(813) 555-0100',
  payments: [
    { id: 'zelle', label: 'Zelle', handle: '(813) 555-0100', fast: true },
    { id: 'cash', label: 'Cash', labelEs: 'Efectivo', handle: '', fast: false }
  ],
  zones: [{ id: 'z1', name: 'Seminole Heights', mi: 5 }, { id: 'z2', name: 'Brandon', mi: 12 }],
  run: { on: true, start: '18:00', end: '21:00', max: 15, zones: ['z1', 'z2'] },
  fees: { freeMiles: 5, midMiles: 10, midFee: 5, farBase: 6, farStepMiles: 5, farStepFee: 1 },
  holdMinutes: 30, setupComplete: true
};
const PRODUCTS = [{
  id: 'p1', name: 'Bolo Runtz', sec: 'Indoors', type: 'Hybrid', thc: '29%', cbd: '0.2%',
  bg: '#ffc6a5', notes: 'Candy gas.', effects: ['Giggly'],
  weights: [['3.5g', 25], ['7g', 40], ['1/2 oz', 80], ['1 oz', 140]], foot: '', stock: 2
}];
const ORDER = {
  id: 'o1', no: '#1041', client: 'Dee R.', clientCode: '4417', at: new Date().toISOString(),
  mode: 'delivery', pay: 'zelle', payLabel: 'Zelle', payOk: false, hold: null, slot: '8:30pm',
  zone: 'z1', where: 'Seminole Heights · 8:30pm',
  items: [{ pid: 'p1', name: 'Bolo Runtz', label: '1 oz', unit: 140, qty: 1, line: '1× Bolo Runtz · 1 oz', price: '$140' }],
  subtotal: 140, fee: 0, total: '$140', step: 0, cancelled: false
};

function render(mutate) {
  const c = new Component();
  c.state = JSON.parse(JSON.stringify(c.state));
  mutate(c.state);
  return c.renderVals();
}

const scenarios = {
  'empty shop, client': s => { Object.assign(s, { screen: 'home', role: 'client', backend: 'ready', cfg: CFG, products: [] }); },
  'stocked shop, client': s => { Object.assign(s, { screen: 'home', role: 'client', backend: 'ready', cfg: CFG, products: PRODUCTS, cart: [{ pid: 'p1', name: 'Bolo Runtz', label: '1 oz', price: 140, qty: 1, weightIdx: 3, bg: '#ffc6a5', initials: 'BR' }], selId: 'p1', zone: 'z1', pay: 'zelle', mode: 'delivery' }); },
  'owner, no data': s => { Object.assign(s, { screen: 'dash', role: 'owner', backend: 'ready', cfg: CFG, products: [], orders: [], signups: [], codes: [] }); },
  'owner, with data': s => { Object.assign(s, { screen: 'queue', role: 'owner', backend: 'ready', cfg: CFG, products: PRODUCTS, orders: [ORDER], stops: 1, signups: [{ id: 's1', name: 'Kiko', phone: '813-555-0188', addr: '4120 E Fowler', age: 31, pay: 'Zelle', at: new Date().toISOString() }], codes: [{ id: 'c1', name: 'Dee R.', code: '4417', active: true, uses: 9 }] }); },
  'owner settings': s => { Object.assign(s, { screen: 'settings', role: 'owner', backend: 'ready', cfg: CFG, products: PRODUCTS, telegram: true }); },
  'first run setup': s => { Object.assign(s, { screen: 'setup', backend: 'setup', needsSetupCode: true, setup: { shopName: '', setupCode: '', pin: '481902', pin2: '', stage: 'confirm', err: '' } }); },
  'confirmation screen': s => { Object.assign(s, { screen: 'confirm', role: 'client', backend: 'ready', cfg: CFG, products: PRODUCTS, last: { no: '#1043', total: '$140', pay: 'cash', mode: 'pickup', holdUntil: Date.now() + 600000, lines: [{ qty: 1, name: 'Bolo Runtz', label: '1 oz', total: '$140' }], modeLabel: 'Pickup', when: 'Pickup 8:15pm' }, hold: 600 }); },
  'backend down': s => { Object.assign(s, { screen: 'down', backend: 'down', fatal: 'nope' }); }
};

console.log('\n— every template binding resolves —');
for (const lang of ['es', 'en']) {
  for (const [name, mutate] of Object.entries(scenarios)) {
    let vals;
    try {
      vals = render(s => { mutate(s); s.lang = lang; });
    } catch (err) {
      check(lang + ' / ' + name + ': renders', false, err.message);
      continue;
    }
    const missing = [...wanted].filter(k => !(k in vals));
    check(lang + ' / ' + name + ': all bindings present', missing.length === 0, missing);

    // A binding that leaks a raw function or object shows up as "[object Object]".
    const leaked = Object.entries(vals).filter(([k, v]) =>
      typeof v === 'function' && !/^(set|pick|go|toggle|add|save|remove|copy|test|submit|place|issue|logout|back|retry|flip|to|press|force|repeat|more|fewer|close|open|confirm|undo|step|revoke|advance|su)/.test(k)
    ).map(([k]) => k);
    check(lang + ' / ' + name + ': no stray functions bound', leaked.length === 0, leaked);

    // Loop rows must carry every field their body reads.
    const rowProblems = [];
    for (const [list, fields] of Object.entries(loopFields)) {
      const rows = vals[list];
      if (!Array.isArray(rows) || !rows.length) continue;
      for (const f of fields) if (!(f in rows[0])) rowProblems.push(list + '.' + f);
    }
    check(lang + ' / ' + name + ': loop rows complete', rowProblems.length === 0, rowProblems);
  }
}

console.log('\n— no demo residue —');
const banned = [
  ['badgeDemo', /badgeDemo/],
  ['hardcoded Zelle handle', /656\)\s*247-1884|6562471884/],
  ['hardcoded Venmo handle', /@Mafutero3000/],
  ['seeded strain names', /Frosted Bananas|Bolo Runtz|Packman|Slurricane|Blue Suzhi|Candy Fumes/],
  ['seeded customers', /Dee R\.|Marcus T\.|Junie|Kiko|Yaz/],
  ['frozen "now"', /new Date\(2026/],
  ['prototype start props', /startInOwnerView|startUnlocked/],
  ['demo backend state', /backend:\s*'demo'|===\s*'demo'/],
  ['hardcoded Tampa zones', /Temple Terrace|Ybor City|Carrollwood/]
];
for (const [name, re] of banned) check('index.html has no ' + name, !re.test(html));

// Numbers typed straight into the markup are how "$1,240 taken today" survived
// on a shop with no orders. Any figure a customer or owner reads must be a
// binding. "00:00" on the expired screen is the one legitimate literal: the
// hold clock really has run out by then.
const visible = template.replace(/<[^>]+>/g, ' ').split(' ')
  .map(s => s.trim())
  .filter(s => s && !s.includes('{{'))
  .filter(s => /\$[\d,]+|\b\d{2,}\b|\b\d+\s*(oz|g|mi|min)\b/.test(s))
  .filter(s => s !== '00:00');
check('no hardcoded figures in the markup', visible.length === 0, visible);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
