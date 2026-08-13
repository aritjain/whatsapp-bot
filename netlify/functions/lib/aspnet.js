'use strict';

/**
 * Helpers for ASP.NET WebForms tracking portals (Sagar Informatics LMS and
 * friends). These render server-side, so unlike a JS single-page app the page
 * can be fetched and parsed directly.
 *
 * The catch is POD links: WebForms commonly wires them to
 * `javascript:__doPostBack('ctl00$...','')` rather than a plain href, so
 * fetching the document is not enough — the postback has to be replayed as a
 * form POST carrying the page's hidden state fields.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const decodeEntities = (s) =>
  String(s == null ? '' : s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

const text = (html) => decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Every <tr> as cells carrying both text and any anchors inside. */
function tableRows(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html))) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c;
    while ((c = tdRe.exec(m[1]))) {
      const inner = c[1];
      const links = [];
      // Match on the actual quote character: WebForms hrefs embed single quotes
      // inside double-quoted attributes, e.g. href="javascript:__doPostBack('x','')".
      const aRe = /<a[^>]*\shref=(["'])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
      let a;
      while ((a = aRe.exec(inner))) links.push({ href: decodeEntities(a[2]), label: text(a[3]) });
      cells.push({ text: text(inner), links });
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** Hidden form state the server requires on a postback. */
function hiddenFields(html) {
  const out = {};
  const re = /<input[^>]+type=["']hidden["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const name = /name=["']([^"']+)["']/i.exec(tag);
    const value = /value=["']([^"']*)["']/i.exec(tag);
    if (name) out[name[1]] = value ? decodeEntities(value[1]) : '';
  }
  return out;
}

/** Pull the control name out of a `__doPostBack('target','arg')` href. */
function postBackTarget(href) {
  const m = /__doPostBack\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]*)['"])?/.exec(String(href || ''));
  return m ? { target: m[1], argument: m[2] || '' } : null;
}

/**
 * Replay a WebForms postback and return the raw response, which for a POD link
 * is usually the image or PDF itself (or a redirect to it).
 */
async function postBack(pageUrl, html, target, argument, extra) {
  const form = { ...hiddenFields(html), __EVENTTARGET: target, __EVENTARGUMENT: argument || '', ...(extra || {}) };
  const body = new URLSearchParams(form).toString();
  return fetch(pageUrl, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: pageUrl,
      Origin: new URL(pageUrl).origin,
      Accept: 'image/*,application/pdf,text/html'
    },
    body,
    redirect: 'follow'
  });
}

const absolute = (href, base) => {
  try {
    return new URL(href, base).toString();
  } catch {
    return '';
  }
};

module.exports = { UA, text, tableRows, hiddenFields, postBackTarget, postBack, absolute, decodeEntities };
