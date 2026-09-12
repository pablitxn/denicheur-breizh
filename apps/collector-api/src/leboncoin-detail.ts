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
