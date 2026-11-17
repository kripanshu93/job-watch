// Job watcher: checks public Greenhouse, Lever and Ashby job boards for new
// US product, program and project manager roles, and opens one GitHub issue
// per new job. Runs on GitHub Actions every 30 minutes. No dependencies.
import fs from "node:fs";

// ---- settings you can change -------------------------------------------
const TITLE_INCLUDE = /product manager|product owner|product management|program manager|project manager|product operations|product ops/i;
const TITLE_EXCLUDE = /\b(staff|principal|director|head of|vp|vice president|group product|chief|intern|internship|co-?op|product marketing|marketing)\b/i;
const MAX_AGE_HOURS = 48;     // ignore anything older than this (first run safety net)
const MAX_ISSUES_PER_RUN = 25; // cap so a big batch can't flood your inbox
// -------------------------------------------------------------------------

const STATES = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
const RE_US = new RegExp(`\\b(united states|usa|u\\.s\\.a?|us-remote|remote[ ,\\-–(]*us\\b|us[ ,\\-–]*remote|new york|san francisco|bay area|seattle|bellevue|boston|chicago|austin|dallas|houston|denver|los angeles|san diego|san jose|palo alto|mountain view|atlanta|washington|charlotte|miami|philadelphia|pittsburgh|portland|salt lake|phoenix|minneapolis|nashville|raleigh|detroit|columbus|mclean|arlington|plano)\\b|,\\s*(${STATES})\\b`, "i");
const RE_NON_US = /\b(canada|toronto|vancouver|mexico|brazil|argentina|colombia|uk|united kingdom|london|ireland|dublin|germany|berlin|france|paris|spain|netherlands|amsterdam|poland|estonia|sweden|switzerland|europe|emea|india|bengaluru|bangalore|singapore|hong kong|japan|tokyo|korea|australia|sydney|israel|apac|latam)\b/i;
function isUS(loc) {
  const s = loc || "";
  if (RE_US.test(s)) return true;
  if (RE_NON_US.test(s)) return false;
  return /^\s*remote\s*$/i.test(s); // plain "Remote" counts; anything unclear doesn't
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "job-watch/1.0", Accept: "application/json" } });
  if (r.status === 404) throw new Error("board not found (check the slug)");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const readers = {
  async greenhouse(slug) {
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    return (d.jobs || []).map(j => ({ id: String(j.id), title: j.title, location: j.location?.name || "",
      published: j.first_published || j.updated_at, url: j.absolute_url, pay: "" }));
  },
  async lever(slug) {
    const d = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    return (Array.isArray(d) ? d : []).map(j => {
      const c = j.categories || {}; const sr = j.salaryRange;
      return { id: j.id, title: j.text, location: (c.allLocations?.length ? c.allLocations.join("; ") : c.location || "") + (j.workplaceType && j.workplaceType !== "unspecified" ? ` (${j.workplaceType})` : ""),
        published: j.createdAt ? new Date(j.createdAt).toISOString() : null, url: j.hostedUrl,
        pay: sr && (sr.min || sr.max) ? `${sr.currency || "USD"} ${Number(sr.min || 0).toLocaleString("en-US")}–${Number(sr.max || 0).toLocaleString("en-US")}` : "" };
    });
  },
  async ashby(slug) {
    const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
    return (d.jobs || []).filter(j => j.isListed !== false).map(j => ({ id: j.id, title: j.title,
      location: [j.location, ...(j.secondaryLocations || []).map(s => s.location)].filter(Boolean).join("; ") + (j.isRemote ? " (remote)" : ""),
      published: j.publishedAt, url: j.jobUrl, pay: j.compensation?.compensationTierSummary || "" }));
  },
};

const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const fmtET = iso => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";

async function createIssue(job) {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN, owner = process.env.GITHUB_REPOSITORY_OWNER;
  if (!repo || !token) { console.log("DRY RUN (no GitHub token):", job.company, "-", job.title); return true; }
  const ageMin = Math.round((Date.now() - Date.parse(job.published)) / 60000);
  const body = [
    `**${job.title}** at **${job.company}**`, "",
    `| | |`, `|---|---|`,
    `| Location | ${job.location || "Not listed"} |`,
    `| Posted | ${fmtET(job.published)} (${ageMin < 120 ? ageMin + " min" : Math.round(ageMin / 60) + " h"} before this check) |`,
    `| Pay | ${job.pay || "Not listed"} |`,
    `| Board | ${job.ats} |`,
    `| Link | ${job.url} |`, "",
    `Job key: \`${job.key}\``, "",
    owner ? `@${owner}` : "",
  ].join("\n");
  const r = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "job-watch" },
    body: JSON.stringify({ title: `${job.title} · ${job.company} · ${job.location || "location n/a"}`.slice(0, 250), body, labels: ["new-job", job.ats] }),
  });
  if (!r.ok) { console.error("Issue failed:", r.status, await r.text()); return false; }
  return true;
}

async function main() {
  const companies = fs.readFileSync("companies.txt", "utf8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  const seen = fs.existsSync("seen.json") ? JSON.parse(fs.readFileSync("seen.json", "utf8")) : { jobs: {}, titles: {} };
  const firstRun = Object.keys(seen.jobs).length === 0;
  const cutoff = Date.now() - MAX_AGE_HOURS * 3600e3;
  const fresh = []; const errors = [];
  let scanned = 0;

  for (let i = 0; i < companies.length; i += 8) {
    await Promise.all(companies.slice(i, i + 8).map(async entry => {
      const [ats, slug] = entry.split(":");
      if (!readers[ats] || !slug) { errors.push(`${entry}: use greenhouse:, lever: or ashby:`); return; }
      try {
        const jobs = await readers[ats](slug);
        scanned += jobs.length;
        for (const j of jobs) {
          const key = `${ats}-${slug}-${j.id}`;
          if (seen.jobs[key]) continue;
          seen.jobs[key] = Date.now();
          if (!TITLE_INCLUDE.test(j.title) || TITLE_EXCLUDE.test(j.title)) continue;
          if (!isUS(j.location)) continue;
          const t = Date.parse(j.published);
          if (isNaN(t) || t < cutoff) continue;
          const dupKey = norm(j.title) + "|" + norm(slug);
          if (seen.titles[dupKey]) continue; // same role already posted under another id or location
          seen.titles[dupKey] = Date.now();
          fresh.push({ ...j, ats, company: slug, key });
        }
      } catch (e) { errors.push(`${entry}: ${e.message}`); }
    }));
  }

  fresh.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  let opened = 0;
  if (firstRun) console.log(`First run: recorded ${Object.keys(seen.jobs).length} existing jobs; only jobs from the last ${MAX_AGE_HOURS}h become issues.`);
  for (const job of fresh.slice(0, MAX_ISSUES_PER_RUN)) if (await createIssue(job)) opened++;
  if (fresh.length > MAX_ISSUES_PER_RUN) console.log(`${fresh.length - MAX_ISSUES_PER_RUN} more matches skipped this run (cap ${MAX_ISSUES_PER_RUN}).`);

  // forget entries older than 60 days so the file stays small
  const old = Date.now() - 60 * 86400e3;
  for (const m of [seen.jobs, seen.titles]) for (const k of Object.keys(m)) if (m[k] < old) delete m[k];
  fs.writeFileSync("seen.json", JSON.stringify(seen));
  console.log(`Checked ${companies.length} companies, ${scanned} jobs. New matches: ${fresh.length}. Issues opened: ${opened}.`);
  if (errors.length) console.log("Problems:\n  " + errors.join("\n  "));
}
main().catch(e => { console.error(e); process.exit(1); });
