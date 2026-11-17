// One-time test: can GitHub's servers get Google results for the site: search?
// Runs two searches (past hour, past day) and reports what came back.
const searches = {
  "past hour": "https://www.google.com/search?q=site:job-boards.greenhouse.io+%22product+manager%22&tbs=qdr:h&hl=en",
  "past day": "https://www.google.com/search?q=site:job-boards.greenhouse.io+%22product+manager%22&tbs=qdr:d&hl=en",
};
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
for (const [label, url] of Object.entries(searches)) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, redirect: "follow" });
    const html = await r.text();
    const blocked = /unusual traffic|not a robot|recaptcha|\/sorry\//i.test(html) || /\/sorry\//.test(r.url);
    const consent = /consent\.google|before you continue/i.test(html) || /consent\./.test(r.url);
    const links = [...new Set(html.match(/job-boards\.greenhouse\.io\/[a-z0-9_-]+\/jobs\/\d+/gi) || [])];
    const companies = [...new Set(links.map(l => l.split("/")[1]))];
    console.log(`\n=== ${label} ===`);
    console.log(`HTTP status: ${r.status}   final URL: ${r.url.slice(0, 80)}`);
    console.log(`Blocked by Google: ${blocked ? "YES" : "no"}   Consent page: ${consent ? "YES" : "no"}`);
    console.log(`Job links found: ${links.length}   Companies: ${companies.join(", ") || "none"}`);
    if (!links.length && !blocked) console.log(`First 300 characters of the page: ${html.replace(/\s+/g, " ").slice(0, 300)}`);
  } catch (e) {
    console.log(`\n=== ${label} ===\nRequest failed: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 5000));
}
