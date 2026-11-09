import { ruleFromCreditRates } from './model.js';

const startsOn = '2026-11-10';
const endsPrevious = '2026-11-09';
const repeat = (count, value) => Array(count).fill(value);
const grade = [];
function add(admin, category, plan, rates, conditions, offsets, equalRate) {
  grade.push({ admin, category, plan, rates, conditions, offsets, equalRate });
}
const bonus = 'Bônus de contemplação: 0,50% do crédito, registrado separadamente quando devido.';
for (const admin of ['HS', 'Serello']) {
  for (const category of ['Imóveis', 'Automóveis']) {
    const terms = 'Até a 8ª parcela, estorno integral da comissão recebida. Depois, sem estorno. ' + bonus;
    add(admin, category, 'Parcela integral', [.5,.2,.2,.2,.4], terms);
    add(admin, category, 'Parcela 50%', [.25,.1,.1,.1,.2], terms);
  }
}
for (const category of ['Imóveis','Automóveis']) {
  const property = category === 'Imóveis';
  const rates = property ? [.6,.2,.2,.2,.4] : [.6,.6,.4];
  const offsets = property ? [0,2,3,4,5] : [0,2,4];
  const cutoff = property ? '10ª' : '6ª';
  const full = property ? '0,50%' : '1,00%';
  const half = property ? '0,25%' : '0,50%';
  for (const reduction of [0,10,20,30,40,50]) {
    const plan = reduction === 0 ? 'Parcela integral' : reduction === 50 ? 'Parcela 50%' : `Flex ${reduction}%`;
    const estorno = reduction === 0 || reduction === 50
      ? `Até a ${cutoff} parcela, estorno de ${reduction === 0 ? full : half} do crédito.`
      : 'Estorno do Flex intermediário a confirmar com a administradora.';
    add('Servopa', category, plan, rates.map(rate => Number((rate * (100-reduction)/100).toFixed(3))), 'PENSE segue a mesma grade. ' + estorno + ' ' + bonus, offsets);
  }
}
add('Itaú','Automóveis','Parcela integral',repeat(4,.4),'Estorno de 100% do recebido até a 3ª parcela.');
add('Itaú','Pesados','Parcela integral',repeat(4,.4),'Estorno de 100% do recebido até a 3ª parcela.');
add('Itaú','Automóveis','Auto reduzida',repeat(10,.16),'Estorno de 100% até a 6ª e 80% da 7ª à 10ª.');
add('Itaú','Imóveis','Parcela integral',repeat(8,.2),'Imóvel padrão. Estorno de 100% até a 8ª.');
add('Itaú','Imóveis','3ª faixa',repeat(10,.16),'Mais de 200 meses e mais de R$ 400 mil. Estorno de 100% até a 8ª.');
add('Itaú','Imóveis','Imóvel reduzida',repeat(13,0),'Total de 1,60% dividido em 13 parcelas. Estorno de 100% até a 13ª.',null,1.6);

const parcelinha = [...repeat(4,.2),...repeat(8,.15)];
const embracon = [
 ['Automóveis','Tabela BA',[.5,.5,.3,.3,.2,.2],'R$ 45 a 180 mil, 80 meses, sem adesão, redução de 25%. Estorno de 0,50% do crédito até a 6ª.'],
 ['Automóveis','Auto APE · Parcelinha',parcelinha,'100 meses, adesão 1,2% em 12x, redução de 25% ou 50%. Sem estorno.'],
 ['Imóveis','Parcelinha',parcelinha,'240 meses, adesão 1,2% em 12x, redução de 25% ou 50%. Sem estorno.'],
 ['Imóveis','Tabela B',repeat(10,.2),'165 meses, sem adesão, redução de 25%. Sem estorno.'],
 ['Pesados','PSR',[.8,.4,.4,.4],'R$ 200 a 700 mil, até 100 meses, sem adesão, redução 25% até 70 meses. Estorno de 0,50% até a 6ª.'],
 ['Pesados','Auto APE · Parcelinha',repeat(10,.2),'R$ 200 a 700 mil, até 100 meses, sem adesão, redução de 25% até 70 meses. Sem estorno.'],
 ['Pesados','Parcelinha',repeat(10,.2),'R$ 350 a 700 mil, até 100 meses, adesão 1,2% em 12x, redução 50% até 100 meses. Sem estorno.'],
];
for (const [category, plan, rates, terms] of embracon) {
  add('Embracon',category,plan,rates,terms);
  add('Embracon',category,plan+' · com seguro',rates.map((rate,i)=>i===1?Number((rate+.15).toFixed(3)):rate),terms+' Adicional de 0,15% na 2ª parcela.');
}
function anchor(category, plan, rates, terms = '') {
  add('Âncora',category,plan,rates,'Sem estorno. '+terms);
}
anchor('Automóveis','Parcela integral',repeat(4,.5),bonus);
anchor('Automóveis','Parcela reduzida 70%',repeat(8,.25),bonus);
anchor('Automóveis','Parcela 50%',repeat(8,.25),bonus);
anchor('Automóveis','Acelera Aí',repeat(16,.125),'Bônus de contemplação a confirmar para este plano.');
anchor('Pesados','Parcela integral',repeat(4,.4));
anchor('Pesados','Parcela reduzida 70%',repeat(8,.2));
anchor('Pesados','Parcela 50%',repeat(16,.1));
for (const category of ['Serviços','Outros bens']) anchor(category,'Parcela integral',repeat(4,.5));
anchor('Outros bens','Ouro · grupos 200',repeat(5,.4));
anchor('Outros bens','Grupo 5001 · normal',repeat(10,.2));
anchor('Outros bens','Grupo 5001 · 50%',[...repeat(8,.15),...repeat(8,.1)]);
for (const [plan, rates] of [['Parcela integral',repeat(10,.2)],['Parcela reduzida 70%',repeat(10,.2)],['Parcela 50%',[.2,...repeat(12,.15)]]]) {
  anchor('Imóveis',plan,rates,'Reajuste INCC / grupo 708. '+bonus);
}
anchor('Imóveis','Acelerado · integral',repeat(5,.4),'Sem bônus de contemplação.');
anchor('Imóveis','Acelerado · 70%',repeat(10,.2),'Sem bônus de contemplação.');
anchor('Imóveis','Acelerado · 50%',[.2,...repeat(12,.15)],'Sem bônus de contemplação.');

const normalize = name => name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();

export function prepareNovemberGrade(state) {
  const administrators = [...state.administrators];
  const additions = grade.map((item, index) => {
    let admin = administrators.find(a => normalize(a.name) === normalize(item.admin));
    if (!admin) {
      admin = { id: 'admin-grade-nov-2026-' + normalize(item.admin), name: item.admin, active: true };
      administrators.push(admin);
    }
    const existing = state.rules.filter(r => r.administratorId === admin.id && r.modality === item.category);
    const exact = existing.find(r => r.active && r.plan === item.plan)
      || (item.admin === 'Embracon' && !item.plan.includes('com seguro')
        ? existing.find(r => normalize(r.name).includes(normalize(item.plan)))
        : undefined);
    const reference = exact || existing.find(r => r.active) || existing[0];
    // Keep known calendar settings. Otherwise the first payment date is entered on the sale.
    return ruleFromCreditRates({
      id: `grade-nov-2026-${index + 1}`, name: `${item.admin} · ${item.category} · ${item.plan} · 10/11/2026`,
      administratorId: admin.id, modality: item.category, plan: item.plan,
      office: String((exact?.officeBps ?? 0) / 100), startsOn, endsOn: '', active: true,
      conditions: item.conditions, calendar: reference?.calendar || { mode: 'manual' },
      basis: item.equalRate ? 'equal' : 'credit', equalRate: item.equalRate,
      parcels: item.rates.map((rate,i)=>({offset:item.offsets?.[i] ?? i,creditRate:String(rate)})),
    }, administrators);
  });
  const adminIds = new Set(additions.map(r=>r.administratorId));
  const rules = state.rules.filter(r=>!additions.some(a=>a.id===r.id)).map(rule=>{
    if (!adminIds.has(rule.administratorId) || !rule.active || rule.endsOn && rule.endsOn < startsOn) return rule;
    // Only close old combinations covered by the grade. Leave unrelated products untouched.
    const admin = administrators.find(a => a.id === rule.administratorId);
    const matches = additions.some(next => next.administratorId === rule.administratorId
      && next.modality === rule.modality
      && (next.plan === rule.plan || (normalize(admin.name) === 'embracon'
        && ['Tabela BA', 'Auto APE · Parcelinha', 'Parcelinha', 'Tabela B'].some(plan =>
          normalize(rule.name).replaceAll(' · ', ' - ').includes(normalize(plan).replaceAll(' · ', ' - '))
          && next.plan === plan))));
    if (!matches) return rule;
    return rule.startsOn >= startsOn ? {...rule,active:false} : {...rule,endsOn:endsPrevious};
  });
  return {...state,administrators,rules:[...rules,...additions]};
}
