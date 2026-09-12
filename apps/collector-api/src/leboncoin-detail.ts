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

/** V5 adds a bounded projection of the current public ad; it never exports tracking or account state. */
export const leboncoinObserveNativeInventory = String.raw`(() => {
  const observed = ${leboncoinObserveDetailRepair};
  observed.preparation = 'leboncoin-native-inventory-v5';
  if (observed.blocked) return observed;
  ${repairPageContext}
  const match = location.pathname.match(/\/(?:ad\/[^/]+\/)?([0-9]+)(?:\.htm)?\/?$/);
  try {
    const ad = JSON.parse(document.querySelector('script#__NEXT_DATA__')?.textContent || 'null')?.props?.pageProps?.ad;
    const listingId = ad?.list_id ?? ad?.id;
    if (!match || listingId === undefined || String(listingId) !== match[1]) return observed;
    const galleryMatches = controls().flatMap(node => {
      const label = normalize(node.textContent || node.getAttribute('aria-label'));
      const count = /^Voir (?:les? )?([0-9]+) photos?$/i.exec(label)?.[1];
      return count === undefined ? [] : [Number(count)];
    });
    const galleryCounts = [...new Set(galleryMatches)];
    const galleryControl = { observed: galleryMatches.length > 0, declaredCount: galleryCounts.length === 1 ? galleryCounts[0] : null };
    const attributes = Array.isArray(ad.attributes) ? ad.attributes.filter(attribute => attribute && typeof attribute.key === 'string').map(attribute => ({ key: attribute.key, value: attribute.value, value_label: attribute.value_label, key_label: attribute.key_label })) : [];
    const inventory = { listingId: String(listingId), attributes, attributesComplete: Array.isArray(ad.attributes) && attributes.length === ad.attributes.length,
      sectionsObserved: { description: headings().some(node => eligible(node) && /^Description$/i.test(normalize(node.textContent))), additionalCriteria: headings().some(node => eligible(node) && /^Les informations clés$/i.test(normalize(node.textContent))) },
      collapsedControls: { description: observed.description.remainingControls, additionalCriteria: observed.additionalCriteria.remainingControls }, galleryControl };
    const title = typeof ad.subject === 'string' ? ad.subject : ad.title;
    const description = typeof ad.body === 'string' ? ad.body : ad.description;
    if (typeof title === 'string' && title.trim()) inventory.title = title;
    if (typeof description === 'string' && description.trim()) inventory.description = description;
    const validPrice = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (validPrice(ad.price) || (Array.isArray(ad.price) && ad.price.length && ad.price.every(validPrice))) inventory.price = ad.price;
    const nativeImages = ad.images;
    if (nativeImages && typeof nativeImages === 'object') {
      const candidates = [nativeImages.urls_large, nativeImages.urls].filter(Array.isArray);
      const chosen = candidates.sort((a, b) => b.length - a.length)[0];
      if (chosen) {
        const urls = [...new Set(chosen.flatMap(value => {
          if (typeof value !== 'string') return [];
          try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? [url.href] : []; } catch { return []; }
        }))];
        const nativeCount = Number.isInteger(nativeImages.nb_images) && nativeImages.nb_images >= 0 ? nativeImages.nb_images : null;
        const declaredCount = nativeCount ?? galleryControl.declaredCount;
        const allEntriesValidAndUnique = urls.length === chosen.length;
        const galleryAgrees = !galleryControl.observed || galleryControl.declaredCount === urls.length;
        inventory.images = { urls, declaredCount, observedCount: urls.length, inventoryComplete: allEntriesValidAndUnique && declaredCount !== null && declaredCount === urls.length && galleryAgrees };
      }
    }
    observed.listingId = String(listingId);
    observed.inventory = inventory;
  } catch { /* Malformed native data cannot establish an inventory. */ }
  return observed;
})()`;

/** V6 retains the pre-dialog listing inventory, then opens only its own native gallery. */
export const leboncoinOpenGalleryAudit = String.raw`(() => {
  const observed = ${leboncoinObserveNativeInventory};
  observed.preparation = 'leboncoin-gallery-audit-v6';
  ${repairPageContext}
  const dialogs = [...document.querySelectorAll('[role="dialog"],dialog')].filter(visible);
  const ownGallery = node => node.closest('[aria-label*="galerie de photos" i],[data-qa-id*="gallery" i],[data-testid*="gallery" i]');
  const matches = controls().filter(node => ownGallery(node) && /^Voir (?:les? )?(?:[0-9]+ )?photos?$/i.test(normalize(node.textContent || node.getAttribute('aria-label'))));
  const allowed = !observed.blocked && Boolean(observed.inventory) && dialogs.length === 0 && matches.length === 1;
  window.__collectorGalleryAuditV6 = { url: location.href, listingId: observed.listingId, openedByOwnControl: allowed, beforeDialogs: dialogs, opener: allowed ? matches[0] : null };
  observed.galleryOpening = { matchingControls: matches.length, existingDialogs: dialogs.length, clicked: allowed, label: allowed ? normalize(matches[0].textContent || matches[0].getAttribute('aria-label')) : null };
  if (allowed) matches[0].click();
  return observed;
})()`;

/** Capture the actual newly opened dialog before closing its own explicit close control. */
export const leboncoinObserveAndCloseGallery = String.raw`(() => {${repairPageContext}
  const state = window.__collectorGalleryAuditV6;
  const result = { preparation: 'leboncoin-gallery-audit-v6', phase: 'gallery', stage: 'before-close', url: location.href, listingId: state?.listingId, blocked: challenge, openedByOwnControl: false, dialogFound: false, counters: [], images: [], mediaKinds: [], nativeImages: { keys: [], urlLists: {}, scalarUrls: {}, counts: {} }, closed: false };
  if (!state || !state.openedByOwnControl || state.url !== location.href || challenge) return result;
  const dialogs = [...document.querySelectorAll('[role="dialog"],dialog')].filter(node => visible(node) && !state.beforeDialogs.includes(node));
  if (dialogs.length !== 1) return result;
  const dialog = dialogs[0]; state.dialog = dialog;
  result.openedByOwnControl = true; result.dialogFound = true;
  result.dialogHeading = normalize(dialog.querySelector('h1,h2,h3,[role="heading"]')?.textContent || dialog.getAttribute('aria-label'));
  const safeUrl = value => { if (typeof value !== 'string' || !value.trim()) return null; try { const url = new URL(value, location.href); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; } };
  const counters = new Map();
  for (const node of dialog.querySelectorAll('span,p,div,button,h1,h2,h3,[aria-label]')) {
    if (!visible(node)) continue;
    for (const text of [normalize(node.textContent), normalize(node.getAttribute('aria-label'))]) {
      const position = /^(?:(?:Photo|Image)\s*)?([0-9]+)\s*(?:\/|sur|of)\s*([0-9]+)$/i.exec(text);
      const photos = /^Photos?\s*\(\s*([0-9]+)\s*\)$/i.exec(text);
      if (position && Number(position[1]) > 0 && Number(position[1]) <= Number(position[2])) counters.set(text, { text, current: Number(position[1]), total: Number(position[2]), kind: 'position' });
      else if (photos && Number(photos[1]) > 0) counters.set(text, { text, total: Number(photos[1]), kind: 'photo-count' });
    }
  }
  result.counters = [...counters.values()];
  const imageUrls = new Set();
  for (const image of dialog.querySelectorAll('img')) {
    if (!visible(image) || image.closest('[data-qa-id="avatar"],[data-qa-id*="recommend"],[data-qa-id*="similar"]')) continue;
    const alt = normalize(image.getAttribute('alt'));
    if (/\b(?:logo|avatar|publicité)\b/i.test(alt)) continue;
    const candidates = [image.currentSrc, image.getAttribute('src'), image.getAttribute('data-src'), ...(image.getAttribute('srcset') || '').split(',').map(value => value.trim().split(/\s+/)[0])];
    for (const candidate of candidates) {
      const url = candidate && safeUrl(candidate);
      if (!url || !/^https:\/\/img\.leboncoin\.fr\//i.test(url) || /(?:[?&]rule=bo-thumb|\/_next\/|\.svg(?:\?|$))/i.test(url) || imageUrls.has(url)) continue;
      imageUrls.add(url); result.images.push({ url, alt });
    }
  }
  const kinds = new Set(result.images.length ? ['photo'] : []);
  if ([...dialog.querySelectorAll('video')].some(visible)) kinds.add('video');
  if ([...dialog.querySelectorAll('iframe')].some(visible)) kinds.add('iframe');
  for (const node of dialog.querySelectorAll('[aria-label],img,h1,h2,h3,button')) {
    if (!visible(node)) continue;
    const label = normalize(node.getAttribute('aria-label') || node.getAttribute('alt') || node.textContent);
    if (/^(?:Plans?|Plans? du bien)(?:\s*\([0-9]+\))?$/i.test(label)) kinds.add('plan');
    if (/^(?:Carte|Map)$/i.test(label)) kinds.add('map');
    if (/^(?:Vidéo|Video|Visite virtuelle)/i.test(label)) kinds.add('video');
  }
  result.mediaKinds = [...kinds];
  try {
    const ad = JSON.parse(document.querySelector('script#__NEXT_DATA__')?.textContent || 'null')?.props?.pageProps?.ad;
    if (String(ad?.list_id ?? ad?.id) === state.listingId && ad.images && typeof ad.images === 'object') {
      result.nativeImages.keys = Object.keys(ad.images);
      for (const [key, value] of Object.entries(ad.images)) {
        if (/url|cover|thumb/i.test(key)) {
          if (Array.isArray(value)) result.nativeImages.urlLists[key] = value.map(safeUrl).filter(Boolean);
          else if (typeof value === 'string' && safeUrl(value)) result.nativeImages.scalarUrls[key] = safeUrl(value);
          else if (value && typeof value === 'object') for (const [nestedKey, nestedValue] of Object.entries(value)) if (/url|cover|thumb/i.test(nestedKey) && typeof nestedValue === 'string' && safeUrl(nestedValue)) result.nativeImages.scalarUrls[key + '.' + nestedKey] = safeUrl(nestedValue);
        } else if (/count|total|^nb_/i.test(key) && Number.isInteger(value) && value >= 0) result.nativeImages.counts[key] = value;
      }
    }
  } catch { /* A malformed native media projection does not establish completeness. */ }
  const close = [...dialog.querySelectorAll('button,[role="button"]')].filter(node => visible(node) && !node.disabled && [node.getAttribute('aria-label'),node.getAttribute('title'),node.textContent].some(value => /^(?:Fermer|Close)(?: (?:la galerie|gallery|dialog|la fenêtre))?$/i.test(normalize(value))));
  result.closeControlCount = close.length; result.closeRequested = close.length === 1;
  if (close.length === 1) { result.closeControlLabel = normalize(close[0].getAttribute('aria-label') || close[0].textContent); close[0].click(); }
  result.closed = result.closeRequested && !visible(dialog);
  state.galleryEvidence = result;
  return result;
})()`;

/** After the close render settles, record restoration before Firecrawl extracts the detail page. */
export const leboncoinVerifyGalleryClosed = String.raw`(() => {${repairPageContext}
  const state = window.__collectorGalleryAuditV6;
  const result = { ...(state?.galleryEvidence || { preparation: 'leboncoin-gallery-audit-v6', phase: 'gallery', url: location.href, listingId: state?.listingId, openedByOwnControl: false, dialogFound: false, counters: [], images: [], mediaKinds: [] }), stage: 'restored', closed: Boolean(state?.galleryEvidence?.closeRequested && state.dialog && !visible(state.dialog)), restoredDetail: Boolean(state?.url === location.href && [...root.querySelectorAll('h1')].some(visible) && ![...document.querySelectorAll('[role="dialog"],dialog')].some(visible)) };
  if (result.closed && result.restoredDetail && state.opener?.isConnected) state.opener.focus();
  delete window.__collectorGalleryAuditV6;
  return result;
})()`;

const galleryV7 = (script:string) => script.replaceAll("leboncoin-gallery-audit-v6", "leboncoin-gallery-walk-v7").replaceAll("__collectorGalleryAuditV6", "__collectorGalleryWalkV7");
export const leboncoinOpenGalleryWalk = galleryV7(leboncoinOpenGalleryAudit)
  .replace("const allowed = !observed.blocked", "const nativeComplete = observed.inventory?.images?.inventoryComplete === true;\n  const allowed = !nativeComplete && !observed.blocked")
  .replace("observed.galleryOpening = {", "observed.galleryOpening = { reason: nativeComplete ? 'native_inventory_complete' : 'gallery_audit_required',")
  .replace("if (allowed) matches[0].click();", "window.__collectorGalleryWalkV7.deadline = Date.now() + 240000;\n  if (allowed) matches[0].click();");
const observeOpenGalleryV7 = galleryV7(leboncoinObserveAndCloseGallery)
  .replace("result.closeRequested = close.length === 1;", "result.closeRequested = !state.walking && close.length === 1;")
  .replace("if (close.length === 1) {", "if (!state.walking && close.length === 1) {");

/** Walk each source-declared position, with progress/time bounds instead of a photo-count limit. */
export const leboncoinWalkAndCloseGallery = String.raw`(async () => {${repairPageContext}
  const state = window.__collectorGalleryWalkV7;
  if (!state?.openedByOwnControl) return { preparation:'leboncoin-gallery-walk-v7', phase:'gallery', stage:'before-close', url:location.href, listingId:state?.listingId, openedByOwnControl:false, dialogFound:false, closed:false, walk:{positions:[],complete:false,stopReason:'not_opened'} };
  state.walking = true;
  const observe = () => ${observeOpenGalleryV7};
  const ownIdentity = () => { try { const ad = JSON.parse(document.querySelector('script#__NEXT_DATA__')?.textContent || 'null')?.props?.pageProps?.ad; return String(ad?.list_id ?? ad?.id) === state.listingId && location.href === state.url; } catch { return false; } };
  const controlsOf = dialog => [...dialog.querySelectorAll('button,[role="button"]')].filter(visible).map(node => ({ label:normalize(node.getAttribute('aria-label')),text:normalize(node.textContent).slice(0,200),title:normalize(node.getAttribute('title')),disabled:Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true') }));
  const positionOf = snapshot => {
    const positions = snapshot.counters.filter(item => item.kind === 'position');
    const unique = new Map(positions.map(item => [item.current + '/' + item.total,item]));
    return unique.size === 1 ? [...unique.values()][0] : null;
  };
  const diagnosticOf = node => {
    const clone=node.cloneNode(true);
    clone.querySelectorAll('script,style,input,textarea,iframe').forEach(item=>item.remove());
    for(const item of [clone,...clone.querySelectorAll('*')]) for(const attribute of [...item.attributes]) if(/^on/i.test(attribute.name)||attribute.name==='value')item.removeAttribute(attribute.name);
    return {html:clone.outerHTML.slice(0,12000),htmlTruncated:clone.outerHTML.length>12000};
  };
  const rectOf = node => { const box=node.getBoundingClientRect();return {left:box.left,top:box.top,right:box.right,bottom:box.bottom}; };
  const viewportOf = node => {
    const group=node.closest('[data-scope="carousel"][data-part="item-group"]');
    const viewport=rectOf(group && state.dialog.contains(group)?group:state.dialog),dialog=rectOf(state.dialog);
    return {left:Math.max(0,viewport.left,dialog.left),top:Math.max(0,viewport.top,dialog.top),right:Math.min(innerWidth,viewport.right,dialog.right),bottom:Math.min(innerHeight,viewport.bottom,dialog.bottom)};
  };
  const explicitActiveOf = node => node.getAttribute('aria-current')==='true'||node.getAttribute('data-state')==='active'||node.getAttribute('aria-hidden')==='false';
  let candidateSlideEvidence=[];
  const activeSlideFor = position => {
    const native=[...state.dialog.querySelectorAll('[data-scope="carousel"][data-part="item"][data-index]')];
    const candidates=native.length?native.filter(node=>node.getAttribute('data-index')===String(position-1)):[...state.dialog.querySelectorAll('[aria-roledescription="slide"],[data-spark-component="carousel-item"],[data-qa-id*="slide"]')];
    candidateSlideEvidence=candidates.map(node=>({position,dataIndex:native.length?Number(node.getAttribute('data-index')):null,ariaHidden:node.getAttribute('aria-hidden'),ariaCurrent:node.getAttribute('aria-current'),dataState:node.getAttribute('data-state'),inert:Boolean(node.closest('[inert]')),visible:visible(node),explicitActive:explicitActiveOf(node),viewport:viewportOf(node),slide:rectOf(node)}));
    const matches=candidates.filter(node=>{
      if(!visible(node)||node.closest('[inert]')||node.getAttribute('aria-current')==='false'||node.getAttribute('data-state')==='inactive'||node.closest('nav,[role="tablist"],aside,[data-qa-id*="recommend"],[data-qa-id*="similar"]'))return false;
      if(!native.length&&!explicitActiveOf(node))return false;
      if(explicitActiveOf(node))return true;
      const slide=rectOf(node),viewport=viewportOf(node),x=(slide.left+slide.right)/2,y=(slide.top+slide.bottom)/2;
      return slide.right>slide.left&&slide.bottom>slide.top&&viewport.right>viewport.left&&viewport.bottom>viewport.top&&x>=viewport.left&&x<=viewport.right&&y>=viewport.top&&y<=viewport.bottom;
    });
    if(matches.length!==1)return null;
    const node=matches[0],selector=native.length?'[data-scope="carousel"][data-part="item"][data-index="'+(position-1)+'"]:not([aria-hidden="true"]):not([inert])':(node.getAttribute('aria-roledescription')==='slide'?'[aria-roledescription="slide"]':node.getAttribute('data-spark-component')==='carousel-item'?'[data-spark-component="carousel-item"]':'[data-qa-id*="slide"]')+(node.getAttribute('aria-current')==='true'?'[aria-current="true"]':node.getAttribute('data-state')==='active'?'[data-state="active"]':'[aria-hidden="false"]');
    return {node,evidence:{position,dataIndex:native.length?Number(node.getAttribute('data-index')):null,ariaHidden:node.getAttribute('aria-hidden'),ariaCurrent:node.getAttribute('aria-current'),dataState:node.getAttribute('data-state'),inert:Boolean(node.closest('[inert]')),matchedSlides:matches.length,selectionBasis:explicitActiveOf(node)?'explicit_active_state':'indexed_geometry',viewport:viewportOf(node),slide:rectOf(node),selector,...diagnosticOf(node)}};
  };
  const activeImagesOf = (snapshot, position, activeSlide) => snapshot.images.filter(item => {
    if(!activeSlide)return false;
    if (/[?&]rule=(?:ad-thumb|bo-thumb|bo-logo)/i.test(item.url)) return false;
    const labelled = /\b(?:image|photo)\s*([0-9]+)/i.exec(item.alt || '');
    if (labelled && Number(labelled[1]) !== position) return false;
    return [...activeSlide.node.querySelectorAll('img')].some(node => {
      if (!visible(node) || node.closest('[inert],a,nav,[role="tablist"],[role="tab"],aside,[data-part="indicator-group"],[data-part="indicator"],[data-qa-id*="thumb"],[data-testid*="thumb"],[data-qa-id*="recommend"],[data-qa-id*="similar"]')) return false;
      const box=node.getBoundingClientRect(),bounds=activeSlide.evidence.viewport;
      return (explicitActiveOf(activeSlide.node)||(box.width>0 && box.height>0 && box.right>bounds.left && box.left<bounds.right && box.bottom>bounds.top && box.top<bounds.bottom)) && [node.currentSrc,node.getAttribute('src'),node.getAttribute('data-src')].includes(item.url);
    });
  });
  const signature = snapshot => JSON.stringify([positionOf(snapshot)?.current,snapshot.images,snapshot.mediaKinds,normalize(state.dialog?.innerText)]);
  const positions = [], seen = new Set(); let total=null,stopReason='unknown',last=null;
  try {
    while (true) {
      if (Date.now() >= state.deadline) { stopReason='deadline'; break; }
      if (!ownIdentity()) { stopReason='identity_changed'; break; }
      const snapshot=observe(); last=snapshot;
      if (snapshot.blocked) { stopReason='blocked'; break; }
      if (!snapshot.dialogFound) { stopReason='dialog_missing'; break; }
      const cursor=positionOf(snapshot);
      if (!cursor) { stopReason='ambiguous_counter'; break; }
      if (total===null) total=cursor.total;
      if (cursor.total!==total) { stopReason='total_changed'; break; }
      if (seen.has(cursor.current)) { stopReason='repeated_position'; break; }
      if (cursor.current!==positions.length+1) { stopReason='nonsequential_position'; break; }
      const activeSlide=activeSlideFor(cursor.current);
      const activeImages=activeImagesOf(snapshot,cursor.current,activeSlide);
      const mediaKinds=[...new Set([...snapshot.mediaKinds.filter(kind=>kind!=='photo'),...(activeImages.length?['photo']:[])])];
      const text=normalize(state.dialog.innerText).slice(0,3000);
      let businessCard=null;
      if(!activeImages.length&&activeSlide){
        const cards=[...activeSlide.node.querySelectorAll('[data-qa-id="business-card-slide"]')].filter(node=>visible(node)&&!node.closest('[inert]'));
        if(cards.length===1){
          const links=[...cards[0].querySelectorAll('a[href]')].filter(node=>{
            if(!visible(node)||node.closest('[inert]')||normalize(node.textContent)!=='Contacter')return false;
            try{const url=new URL(node.getAttribute('href'),location.href);return url.protocol==='https:'&&url.origin===location.origin&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/reply/'+state.listingId;}catch{return false;}
          });
          if(links.length===1)businessCard={selector:'[data-qa-id="business-card-slide"]',replyUrl:new URL(links[0].getAttribute('href'),location.href).href,linkText:'Contacter'};
        }
      }
      const nonPhotoEvidence = !activeImages.length && activeSlide && (businessCard||/\b(?:contacter le vendeur|envoyer un message|cette annonce vous int[ée]resse)\b/i.test(normalize(activeSlide.node.innerText))) ? {kind:'contact',text:normalize(activeSlide.node.innerText),selector:activeSlide.evidence.selector,...(businessCard?{businessCard}:{})} : null;
      if(nonPhotoEvidence)mediaKinds.push('contact');
      positions.push({position:cursor.current,total:cursor.total,counterText:cursor.text,images:snapshot.images,activeImages,mediaKinds,text,controls:controlsOf(state.dialog),candidateSlideEvidence,...(activeSlide?{activeSlideEvidence:activeSlide.evidence}:{}),...(nonPhotoEvidence?{nonPhotoEvidence}:{})}); seen.add(cursor.current);
      if (seen.size===total) { stopReason='all_positions_observed'; break; }
      const next=[...state.dialog.querySelectorAll('button[aria-label],[role="button"][aria-label]')].filter(node=>visible(node) && !node.disabled && node.getAttribute('aria-disabled')!=='true' && /^(?:Next(?: (?:slide|photo|image))?|Suivante?|(?:Photo|Image) suivante|(?:Afficher|Voir|Aller à) (?:la photo|l['’]image) suivante)$/i.test(normalize(node.getAttribute('aria-label'))));
      if (next.length!==1) { stopReason=next.length?'ambiguous_next':'next_missing'; break; }
      const previous=signature(snapshot); next[0].click();
      const progressDeadline=Math.min(state.deadline,Date.now()+4000); let stableSignature=null,stableSince=0,advanced=false;
      while(Date.now()<progressDeadline) {
        await new Promise(resolve=>setTimeout(resolve,50));
        if(!ownIdentity())break;
        const candidate=observe(),candidateCursor=positionOf(candidate),candidateSignature=signature(candidate);
        if(candidateCursor && candidateCursor.current!==cursor.current && candidateSignature!==previous && activeSlideFor(candidateCursor.current)) {
          if(candidateSignature===stableSignature && Date.now()-stableSince>=150) { advanced=true;break; }
          if(candidateSignature!==stableSignature){stableSignature=candidateSignature;stableSince=Date.now();}
        } else { stableSignature=null;stableSince=0; }
      }
      if(!advanced){stopReason=Date.now()>=state.deadline?'deadline':!ownIdentity()?'identity_changed':'stalled';break;}
    }
  } catch(error) { stopReason='script_error'; }
  let diagnosticHtml='',diagnosticHtmlTruncated=false;
  if(state.dialog){const diagnostic=diagnosticOf(state.dialog);diagnosticHtml=diagnostic.html;diagnosticHtmlTruncated=diagnostic.htmlTruncated;}
  state.walking=false;
  const closed=observe();
  const photos=new Map();for(const item of positions.flatMap(item=>item.images))if(!photos.has(item.url))photos.set(item.url,item);
  const result={...closed,preparation:'leboncoin-gallery-walk-v7',images:[...photos.values()],walk:{positions,declaredTotal:total,visitedPositions:[...seen],complete:stopReason==='all_positions_observed',stopReason,deadlineMs:240000},diagnosticHtml,diagnosticHtmlTruncated};
  state.galleryEvidence=result;
  return result;
})()`;
export const leboncoinVerifyGalleryWalkClosed = galleryV7(leboncoinVerifyGalleryClosed);
