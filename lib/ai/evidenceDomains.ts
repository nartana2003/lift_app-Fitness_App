/**
 * Server-only. The fixed list of web domains the evidence-picks route may
 * search, and what each one is. This is a constant: it never comes from user
 * input or from the model. The publisher name and kind shown next to a source
 * come only from this table, never from page text or the model.
 */

export type SourceKind = "journal" | "organisation" | "news";

export const SOURCE_KINDS: readonly SourceKind[] = ["journal", "organisation", "news"];

export type EvidenceDomain = {
  /** Plain hostname; subdomains are covered too. */
  domain: string;
  publisher: string;
  kind: SourceKind;
};

/** Every domain the search may return, grouped by kind. */
export const EVIDENCE_DOMAINS: readonly EvidenceDomain[] = [
  // Journals and research indexes.
  { domain: "pubmed.ncbi.nlm.nih.gov", publisher: "PubMed", kind: "journal" },
  { domain: "ncbi.nlm.nih.gov", publisher: "PubMed Central (NCBI)", kind: "journal" },
  { domain: "journals.lww.com", publisher: "Lippincott journals (LWW)", kind: "journal" },
  { domain: "link.springer.com", publisher: "Springer", kind: "journal" },
  { domain: "tandfonline.com", publisher: "Taylor & Francis", kind: "journal" },
  { domain: "sciencedirect.com", publisher: "ScienceDirect", kind: "journal" },
  { domain: "bjsm.bmj.com", publisher: "British Journal of Sports Medicine", kind: "journal" },
  { domain: "jssm.org", publisher: "Journal of Sports Science and Medicine", kind: "journal" },
  { domain: "frontiersin.org", publisher: "Frontiers", kind: "journal" },
  { domain: "journals.humankinetics.com", publisher: "Human Kinetics journals", kind: "journal" },
  { domain: "journals.physiology.org", publisher: "American Physiological Society journals", kind: "journal" },
  // Professional and health organisations.
  { domain: "nsca.com", publisher: "NSCA", kind: "organisation" },
  { domain: "acsm.org", publisher: "ACSM", kind: "organisation" },
  { domain: "who.int", publisher: "World Health Organization", kind: "organisation" },
  { domain: "nih.gov", publisher: "NIH", kind: "organisation" },
  { domain: "nhs.uk", publisher: "NHS", kind: "organisation" },
  { domain: "health.harvard.edu", publisher: "Harvard Health Publishing", kind: "organisation" },
  // Reputable news outlets (science and health desks).
  { domain: "reuters.com", publisher: "Reuters", kind: "news" },
  { domain: "bbc.com", publisher: "BBC", kind: "news" },
  { domain: "bbc.co.uk", publisher: "BBC", kind: "news" },
  { domain: "npr.org", publisher: "NPR", kind: "news" },
  { domain: "theguardian.com", publisher: "The Guardian", kind: "news" },
];

const coveredBy = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/**
 * The allowed_domains list sent to the search tool: every table domain, minus
 * those already covered by a broader entry (ncbi.nlm.nih.gov is covered by
 * nih.gov). Results are still checked against the full table in code.
 */
export const ALLOWED_DOMAINS: readonly string[] = EVIDENCE_DOMAINS.map((d) => d.domain).filter(
  (d, i, all) => all.indexOf(d) === i && !all.some((other) => other !== d && coveredBy(d, other)),
);

/**
 * The table entry for a hostname: the most specific domain that covers it
 * (pubmed.ncbi.nlm.nih.gov is a journal index, not "NIH"). Null when the host
 * is not on the list.
 */
export function domainFor(hostname: string): EvidenceDomain | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  let best: EvidenceDomain | null = null;
  for (const d of EVIDENCE_DOMAINS) {
    if (coveredBy(host, d.domain) && (!best || d.domain.length > best.domain.length)) best = d;
  }
  return best;
}
