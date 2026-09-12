/** Native page interaction only: expand the description before provider extraction. */
export const leboncoinExpandDescription = `(() => {
  const normalize = value => (value || '').replace(/\\s+/g, ' ').trim();
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,[role="heading"]')];
  const heading = headings.find(node => /^description$/i.test(normalize(node.textContent)));
  const controls = [...document.querySelectorAll('button,[role="button"]')]
    .filter(node => /^voir plus$/i.test(normalize(node.textContent)));
  let clicked = 0;
  for (const control of controls) {
    if (!heading || !(heading.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    const intervening = headings.some(node => node !== heading &&
      (heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      (node.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (intervening || !control.getClientRects().length || control.disabled) continue;
    control.click(); clicked += 1;
    break;
  }
  return { preparation: 'leboncoin-expand-description-v1', descriptionHeadingFound: Boolean(heading), matchingControls: controls.length, clicked };
})()`;

const repairPageContext = String.raw`
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const root = document.querySelector('main') || document.body;
  const headings = () => [...root.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')];
  const visible = node => Boolean(node && node.isConnected && node.getClientRects().length && !node.closest('[hidden],[aria-hidden="true"],template,script,style'));
  const recommendations = headings().find(node => /^(?:Ces annonces peuvent vous intéresser|Annonces similaires|Vous aimerez aussi|Nos recommandations)$/i.test(normalize(node.textContent)));
  const eligible = node => visible(node) && !node.closest('aside,nav,footer,[data-qa-id*="similar"],[data-qa-id*="recommend"],[data-testid*="recommend"]') && (!recommendations || !(recommendations.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
  const challenge = [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="datadome"],[id="captcha"]')].some(visible) || /^(?:Vérifiez que vous êtes humain|Verify you are human|Access denied)$/i.test(normalize(document.querySelector('h1')?.textContent));
  const controls = () => [...root.querySelectorAll('button,[role="button"]')].filter(node => eligible(node) && !node.disabled);
  const inSection = (node, title) => {
    const heading = headings().find(candidate => eligible(candidate) && title.test(normalize(candidate.textContent)));
    if (!heading || !(heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    const level = Number(heading.getAttribute('aria-level')) || Number(heading.tagName.slice(1)) || 2;
    return !headings().some(candidate => candidate !== heading && (Number(candidate.getAttribute('aria-level')) || Number(candidate.tagName.slice(1)) || 2) <= level && (heading.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) && (candidate.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
  };
`;

/** V4 clicks only two explicit read-only disclosure controls; observation happens after settling. */
export const leboncoinPrepareDetailRepair = String.raw`(() => {${repairPageContext}
  const expand = (heading, label) => {
    const matches = controls().filter(node => label.test(normalize(node.textContent)) && inSection(node, heading));
    if (!challenge && matches.length === 1) matches[0].click();
    return { matchingControls: matches.length, clicked: !challenge && matches.length === 1 ? 1 : 0 };
  };
  return { preparation: 'leboncoin-detail-repair-v4', phase: 'prepare', url: location.href, blocked: challenge,
    description: expand(/^Description$/i, /^Voir plus$/i),
    additionalCriteria: expand(/^Les informations clés$/i, /^Voir (?:les? |tous les )?(?:[0-9]+ )?critères? supplémentaires$/i) };
})()`;

/** Source evidence uses selected DOM values and the current ad's public native attributes only. */
export const leboncoinObserveDetailRepair = String.raw`(() => {${repairPageContext}
  if (challenge) return { preparation: 'leboncoin-detail-repair-v4', phase: 'observe', url: location.href, blocked: true, criteria: [], fields: {}, features: [], structuredData: [] };
  const criteria = [], features = [], fields = {}, structuredData = [];
  for (const item of root.querySelectorAll('[data-qa-id^="criteria_item_"]')) {
    if (!eligible(item)) continue;
    const key = item.getAttribute('data-qa-id');
    if (key === 'criteria_item_energy_rate' || key === 'criteria_item_ges') continue;
    const paragraphs = [...item.querySelectorAll('p,dt,dd')].filter(eligible);
    const label = normalize(paragraphs[0]?.textContent);
    const titled = [...item.querySelectorAll('[title]')].find(node => eligible(node) && normalize(node.getAttribute('title')) !== label);
    const value = normalize(titled?.getAttribute('title') || paragraphs.slice(1).map(node => normalize(node.textContent)).join(', '));
    if (!label || !value) continue;
    const selector = '[data-qa-id="' + key + '"]';
    const evidence = label + ': ' + value;
    criteria.push({ label, value, evidence, selector });
    if (/^(?:Caractéristiques|Extérieur)$/i.test(label)) features.push({ value, evidence, selector });
  }
  for (const [field, key, title] of [['energyClass', 'energy_rate', 'Classe énergie'], ['gesClass', 'ges', 'GES']]) {
    const selector = '[data-qa-id="criteria_item_' + key + '"]';
    const candidates = [], explicitStates = [];
    for (const item of root.querySelectorAll(selector)) {
      if (!eligible(item)) continue;
      const literal = normalize(item.innerText || item.textContent);
      if (/\b(?:non soumis|non assujetti|non applicable|exempt[ée]?|non renseign[ée]?|non communiqu[ée]?)\b/i.test(literal)) explicitStates.push(literal);
      const scale = [...item.querySelectorAll('[title]')].find(node => normalize(node.getAttribute('title')) === title);
      if (!scale) continue;
      for (const node of scale.querySelectorAll('div,[aria-selected],[aria-current],[data-selected]')) {
        const value = normalize(node.textContent).toUpperCase();
        if (!eligible(node) || !/^[A-G]$/.test(value)) continue;
        const selected = (node.classList.contains('border-solid') && node.classList.contains('drop-shadow-sm')) || node.getAttribute('aria-selected') === 'true' || node.getAttribute('aria-current') === 'true' || node.getAttribute('data-selected') === 'true';
        if (selected) candidates.push({ value, evidence: title + ': ' + value + '; selected element ' + node.outerHTML, selector, selected: true });
      }
    }
    const values = [...new Set(candidates.map(candidate => candidate.value))];
    if (values.length === 1) fields[field] = candidates.find(candidate => candidate.value === values[0]);
    else if (candidates.length) fields[field] = { value: null, evidence: title + ': conflicting selected grades ' + values.join(', '), selector, selected: false };
    else if (explicitStates.length === 1) fields[field] = { value: null, evidence: title + ': ' + explicitStates[0], selector, selected: false };
  }
  const match = location.pathname.match(/\/(?:ad\/[^/]+\/)?([0-9]+)(?:\.htm)?\/?$/);
  try {
    const ad = JSON.parse(document.querySelector('script#__NEXT_DATA__')?.textContent || 'null')?.props?.pageProps?.ad;
    const listingId = ad?.list_id ?? ad?.id;
    if (match && listingId !== undefined && String(listingId) === match[1] && Array.isArray(ad.attributes)) {
      const supported = new Set(['energy_rate','ges','land_plot_surface','bedrooms','rooms','square','real_estate_type','specificities','outside_access']);
      const attributes = ad.attributes.filter(attribute => supported.has(attribute?.key)).map(attribute => ({ key: attribute.key, value: attribute.value, value_label: attribute.value_label, key_label: attribute.key_label }));
      structuredData.push({ selector: 'script#__NEXT_DATA__', path: 'props.pageProps.ad.attributes', listingId: String(listingId), attributes });
      for (const [field, key, label] of [['energyClass','energy_rate','Classe énergie'],['gesClass','ges','GES']]) {
        if (fields[field]) continue;
        const matching = attributes.filter(attribute => attribute.key === key && /^[A-G]$/i.test(String(attribute.value)));
        const values = [...new Set(matching.map(attribute => String(attribute.value).toUpperCase()))];
        if (values.length === 1) fields[field] = { value: values[0], evidence: label + ': ' + values[0] + '; current listing ' + listingId + ' native attribute ' + JSON.stringify(matching), selector: 'script#__NEXT_DATA__', selected: true };
        else if (!values.length) {
          const explicit = attributes.filter(attribute => attribute.key === key).map(attribute => normalize(attribute.value_label || attribute.value)).filter(value => /\b(?:non soumis|non assujetti|non applicable|exempt[ée]?|non renseign[ée]?|non communiqu[ée]?)\b/i.test(value));
          const states = [...new Set(explicit)];
          if (states.length === 1) fields[field] = { value: null, evidence: label + ': ' + states[0] + '; current listing ' + listingId + ' native attribute ' + key, selector: 'script#__NEXT_DATA__', selected: false };
        }
      }
    }
  } catch { /* Invalid or unrelated native data is not evidence. */ }
  return { preparation: 'leboncoin-detail-repair-v4', phase: 'observe', url: location.href, blocked: false, criteria, fields, features, structuredData,
    description: { remainingControls: controls().filter(node => /^Voir plus$/i.test(normalize(node.textContent)) && inSection(node, /^Description$/i)).length },
    additionalCriteria: { remainingControls: controls().filter(node => /^Voir (?:les? |tous les )?(?:[0-9]+ )?critères? supplémentaires$/i.test(normalize(node.textContent)) && inSection(node, /^Les informations clés$/i)).length } };
})()`;
